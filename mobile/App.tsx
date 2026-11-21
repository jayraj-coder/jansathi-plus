import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo, ActivityIndicator, Alert, Animated, BackHandler, FlatList, Image, KeyboardAvoidingView,
  Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput,
  View, useColorScheme,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as DocumentPicker from 'expo-document-picker';
import { Camera, CameraView } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { ChatResponse, DocumentRecord, Language } from './src/api/client';
import { api, ApiError } from './src/api/client';
import { getGuestId, readSetting, rotateGuestId, saveSetting } from './src/session';
import { languageNames, t } from './src/i18n';
import { palettes, type ThemeMode } from './src/theme';
import { AnimatedAction } from './src/components/AnimatedAction';
import { MarkdownContent } from './src/components/MarkdownContent';
import ReanimatedAnimated, { FadeInDown, FadeOutUp } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { HomeAtmosphere } from './src/components/HomeAtmosphere';
import { HomeHeading } from './src/components/HomeHeading';
import { ChatLoading } from './src/components/ChatLoading';
import { ProcessingModal } from './src/components/ProcessingModal';

type Draft = { uri: string; name: string; mime: string; size?: number; preview?: string; scanned?: boolean };
type ChatLine = { id: string; role: 'user' | 'assistant' | 'error'; text: string; failedQuestion?: string };
type Stage = 'intake' | 'workspace' | 'chat' | 'history' | 'settings';
const MAX_BYTES = 20 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = { pdf: 'application/pdf', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

export default function App() {
  const systemScheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [language, setLanguage] = useState<Language>('en');
  const [guestId, setGuestId] = useState('');
  const router = useRouter();
  const params = useLocalSearchParams<{ stage?: string }>();
  const stage: Stage = params.stage === 'workspace' || params.stage === 'chat' || params.stage === 'history' || params.stage === 'settings' ? params.stage : 'intake';
  const setStage = (value: Stage) => router.setParams({ stage: value === 'intake' ? undefined : value });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [document, setDocument] = useState<DocumentRecord | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadComplete, setUploadComplete] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [serverWorking, setServerWorking] = useState(false);
  const [overviewWorking, setOverviewWorking] = useState(false);
  const [overviewLocalized, setOverviewLocalized] = useState(true);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [message, setMessage] = useState('');
  const [chatLines, setChatLines] = useState<ChatLine[]>([]);
  const [sending, setSending] = useState(false);
  const [healthNote, setHealthNote] = useState('');
  const [history, setHistory] = useState<DocumentRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [openingDocument, setOpeningDocument] = useState<DocumentRecord | null>(null);
  const listRef = useRef<FlatList<ChatLine>>(null);
  const uploadLock = useRef(false);
  const insets = useSafeAreaInsets();
  const screenMotion = useRef(new Animated.Value(1)).current;
  const colors = palettes[themeMode === 'system' ? (systemScheme === 'light' ? 'light' : 'dark') : themeMode];
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const tr = useCallback((key: Parameters<typeof t>[1]) => t(language, key), [language]);
  const localizedError = (error: unknown) => {
    if (!(error instanceof ApiError)) return tr('serverError');
    if (!error.status) return tr('networkFailure');
    if (error.status === 401) return tr('sessionInvalid');
    if (error.status === 404) return tr('missingDocument');
    if (error.status === 413) return tr('fileTooLarge');
    if (error.status === 415) return tr('unsupportedFile');
    return tr('serverError');
  };

  useEffect(() => {
    let active = true;
    Promise.all([getGuestId(), readSetting('theme', 'system' as ThemeMode), readSetting('language', 'en' as Language)])
      .then(([id, theme, lang]) => { if (active) { setGuestId(id); setThemeMode(theme); setLanguage(lang); } })
      .catch(() => { if (active) setHealthNote(tr('storageError')); });
    api.health().then((result: any) => {
      if (active && result.database !== 'connected') setHealthNote(`API storage status: ${result.database || 'unknown'}.`);
    }).catch(() => { if (active) setHealthNote(tr('serverWarning')); });
    return () => { active = false; };
  }, [tr]);

  useEffect(() => {
    if (reduceMotion) { screenMotion.setValue(1); return; }
    screenMotion.setValue(0.88);
    Animated.spring(screenMotion, { toValue: 1, speed: 18, bounciness: 2, useNativeDriver: true }).start();
  }, [stage, screenMotion, reduceMotion]);

  useEffect(() => {
    if (stage === 'intake') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      router.setParams({ stage: stage === 'chat' ? 'workspace' : undefined });
      return true;
    });
    return () => subscription.remove();
  }, [stage, router]);

  useEffect(() => {
    let active = true;
    AccessibilityInfo.isReduceMotionEnabled().then(value => { if (active) setReduceMotion(value); }).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => { active = false; subscription.remove(); };
  }, []);

  const setLang = (value: Language) => { setLanguage(value); void saveSetting('language', value); };
  const setTheme = (value: ThemeMode) => { setThemeMode(value); void saveSetting('theme', value); };

  const openHistory = async () => {
    setStage('history'); setHistoryLoading(true); setHealthNote('');
    try { setHistory(await api.documents(guestId)); }
    catch (error) { setHealthNote(localizedError(error)); }
    finally { setHistoryLoading(false); }
  };
  const openHistoryDocument = async (record: DocumentRecord) => {
    setOpeningDocument(record); setHealthNote('');
    try { setDocument(await api.detail(guestId, record.id)); setDraft(null); setChatLines([]); setStage('workspace'); }
    catch (error) { setHealthNote(localizedError(error)); }
    finally { setOpeningDocument(null); }
  };

  const chooseFile = async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/png', 'image/jpeg'],
        copyToCacheDirectory: true, multiple: false,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      const extension = asset.name.split('.').pop()?.toLowerCase() || '';
      const mime = MIME_BY_EXT[extension];
      if (!mime) { Alert.alert(tr('fileError')); return; }
      if (asset.size !== undefined && asset.size > MAX_BYTES) { Alert.alert(tr('fileTooLarge')); return; }
      setDraft({ uri: asset.uri, name: asset.name, mime: asset.mimeType || mime, size: asset.size, preview: mime.startsWith('image/') ? asset.uri : undefined });
      setDocument(null);
    } catch { Alert.alert(tr('fileError')); }
  };

  const scanDocument = async () => {
    try {
      const permission = await Camera.requestCameraPermissionsAsync();
      if (!permission.granted) { Alert.alert(tr('permission')); return; }
      const result = await CameraView.scanDocumentAsync({ requestPdf: true, quality: 0.92 });
      if (!result?.pages?.length) { Alert.alert(tr('noScan')); return; }
      if (result.pdfUri) {
        const name = `JanSathi-scan-${Date.now()}.pdf`;
        setDraft({ uri: result.pdfUri, name, mime: 'application/pdf', preview: result.pages[0], scanned: true });
      } else {
        setDraft({ uri: result.pages[0], name: `JanSathi-scan-${Date.now()}.jpg`, mime: 'image/jpeg', preview: result.pages[0], scanned: true });
      }
      setDocument(null);
    } catch { Alert.alert(tr('noScan')); }
  };

  const rotateDraft = async () => {
    if (!draft || !draft.mime.startsWith('image/')) return;
    try {
      const output = await manipulateAsync(draft.uri, [{ rotate: 90 }], { compress: 0.9, format: SaveFormat.JPEG });
      setDraft({ ...draft, uri: output.uri, preview: output.uri, mime: 'image/jpeg', name: draft.name.replace(/\.[^.]+$/, '.jpg'), size: undefined });
    } catch { Alert.alert(tr('rotateError')); }
  };

  const removeDraft = () => { setDraft(null); setDocument(null); setProgress(null); };

  const processDocument = () => {
    if (!draft || !guestId) return;
    Alert.alert(tr('confirm'), tr('confirmPrompt'), [
      { text: tr('cancel'), style: 'cancel' },
      { text: tr('confirm'), onPress: () => { void uploadDraft(); } },
    ]);
  };

  const uploadDraft = async () => {
    if (!draft || !guestId || uploadLock.current) return;
    if (draft.size !== undefined && draft.size > MAX_BYTES) { Alert.alert(tr('fileTooLarge')); return; }
    uploadLock.current = true;
    setUploadError(''); setUploadComplete(false);
    setUploading(true); setProgress(null); setServerWorking(false); setHealthNote('');
    try {
      const uploaded = await api.upload(guestId, draft.uri, draft.name, draft.mime, (loaded, total) => {
        if (total > 0) setProgress(Math.min(100, Math.round((loaded / total) * 100)));
      }, () => { setServerWorking(true); setProgress(null); });
      setDocument(uploaded);
      setOverviewLocalized(false);
      try { setDocument(await api.detail(guestId, uploaded.id)); } catch { /* Upload response already contains the safe overview. */ }
      if (uploaded.status === 'completed') {
        setOverviewWorking(true);
        try {
          const localized = await api.overview(guestId, uploaded.id, language);
          setDocument(current => current ? { ...current, overview: localized.answer } : current);
          setOverviewLocalized(true);
        } catch { /* Keep the server's extractive overview if AI is unavailable. */ }
      } else {
        setOverviewLocalized(true);
      }
      setUploadComplete(true);
      await new Promise<void>(resolve => setTimeout(resolve, reduceMotion ? 100 : 520));
      setStage('workspace'); setChatLines([]); setMessage('');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        try { setGuestId(await rotateGuestId()); } catch { /* Keep the visible session error. */ }
      }
      const messageText = localizedError(error);
      setHealthNote(messageText); setUploadError(messageText);
    } finally { uploadLock.current = false; setUploading(false); setProgress(null); setServerWorking(false); setOverviewWorking(false); setUploadComplete(false); }
  };

  const sendMessage = async (retry?: string) => {
    const question = (retry || message).trim();
    if (!question || !document || !guestId || sending) return;
    setMessage('');
    const userLine: ChatLine = { id: `${Date.now()}-u`, role: 'user', text: question };
    setChatLines(lines => [...lines, userLine]); setSending(true);
    try {
      const result: ChatResponse = await api.chat(guestId, question, document.id, language);
      setChatLines(lines => [...lines, { id: `${Date.now()}-a`, role: 'assistant', text: result.answer }]);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setChatLines(lines => [...lines, { id: `${Date.now()}-e`, role: 'error', text: localizedError(error), failedQuestion: question }]);
        setDocument(null); setDraft(null); setStage('intake');
        try { setGuestId(await rotateGuestId()); } catch { /* Keep the fresh-session flow visible. */ }
        return;
      }
      setChatLines(lines => [...lines, { id: `${Date.now()}-e`, role: 'error', text: localizedError(error), failedQuestion: question }]);
    } finally { setSending(false); setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 120); }
  };

  const processingMessage = overviewWorking ? tr('overviewWorking') : serverWorking ? tr('server') : progress !== null ? `${tr('uploading')} · ${progress}%` : tr('uploading');

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'right', 'bottom', 'left']}>
      <ExpoStatusBar style={colors === palettes.light ? 'dark' : 'light'} />
      <StatusBar barStyle={colors === palettes.light ? 'dark-content' : 'light-content'} />
      <View style={styles.page}>
        <HomeAtmosphere colors={colors} active={stage === 'intake'} reduceMotion={reduceMotion} />
        <View style={styles.topbar}>
          {stage === 'intake' ? <View style={styles.brandMark}><Text style={styles.brandGlyph}>{'\u091C'}</Text></View> : <Pressable accessibilityRole="button" onPress={() => setStage(stage === 'chat' ? 'workspace' : 'intake')} style={styles.back}><Text style={styles.backText}>‹  {tr('back')}</Text></Pressable>}
          <View style={styles.brandText}><Text style={styles.brand}>JanSathi <Text style={styles.plus}>Plus</Text></Text><Text style={styles.brandTag}>YOUR DOCUMENT COMPANION</Text></View>
          {stage === 'intake' ? <View style={styles.online}><View style={styles.dot}/><Text style={styles.onlineText}>READY</Text></View> : null}
        </View>

        <Animated.View style={{ flex: 1, opacity: screenMotion, transform: [{ translateY: screenMotion.interpolate({ inputRange: [0.88, 1], outputRange: [9, 0] }) }] }}>
        {stage === 'intake' ? (
          <ScrollView contentContainerStyle={styles.intakeContent} keyboardShouldPersistTaps="handled">
            <HomeHeading colors={colors} reduceMotion={reduceMotion} subtitle={tr('intro')} />

            {healthNote ? <View style={styles.notice}><Text style={styles.noticeText}>{healthNote}</Text></View> : null}

            {draft ? <View style={styles.draftCard}>
              <View style={styles.draftTop}><Text style={styles.sectionEyebrow}>{tr('selected').toUpperCase()}</Text><Pressable onPress={removeDraft}><Text style={styles.removeText}>{tr('remove')}</Text></Pressable></View>
              {draft.preview ? <Image source={{ uri: draft.preview }} style={styles.preview} resizeMode="contain"/> : <View style={styles.filePreview}><Text style={styles.pdfGlyph}>{draft.mime === 'application/pdf' ? 'PDF' : 'DOC'}</Text><Text style={styles.fileName}>{draft.name}</Text></View>}
              <Pressable onPress={() => void chooseFile()} style={styles.replaceRow}><Text style={styles.replaceText}>＋  {tr('replace')}</Text></Pressable>
              <View style={styles.fileInfo}><View style={styles.fileIcon}><Text style={styles.fileIconText}>{draft.mime === 'application/pdf' ? 'PDF' : draft.mime.startsWith('image/') ? 'IMG' : draft.mime === 'text/plain' ? 'TXT' : 'DOC'}</Text></View><View style={{ flex: 1 }}><Text style={styles.fileName} numberOfLines={1}>{draft.name}</Text><Text style={styles.fileMeta}>{draft.size ? `${(draft.size / 1024 / 1024).toFixed(2)} MB` : draft.scanned ? tr('scanned') : tr('readyFile')}</Text></View>
                {draft.scanned && draft.mime.startsWith('image/') ? <Pressable onPress={() => void rotateDraft()} style={styles.rotate}><Text style={styles.rotateText}>↻</Text><Text style={styles.rotateLabel}>{tr('rotate')}</Text></Pressable> : null}
              </View>
              {!uploading ? <Pressable style={styles.primary} onPress={processDocument}><LinearGradient colors={[colors.accent, colors.pink]} style={styles.primaryInner}><Text style={styles.primaryText}>{tr('confirm')}  →</Text></LinearGradient></Pressable> : <View style={styles.uploading}>{reduceMotion ? <View style={[styles.loadingDot, { backgroundColor: colors.accent }]} /> : <ActivityIndicator color={colors.accent}/>}<View style={{ flex: 1 }}><Text style={styles.uploadTitle}>{tr('processing')}</Text><Text style={styles.uploadHint}>{processingMessage}</Text></View></View>}
              {uploading && progress !== null ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]}/></View> : null}
              {healthNote && !uploading ? <Pressable style={styles.retryRow} onPress={() => void uploadDraft()}><Text style={styles.retryText}>{tr('retry')}  ↻</Text></Pressable> : null}
            </View> : <View style={styles.actions}>
              <AnimatedAction kind="upload" title={tr('upload')} hint="PDF / DOCX / TXT / JPG / PNG" colors={colors} reduceMotion={reduceMotion} onPress={() => void chooseFile()} />
              <AnimatedAction kind="scan" title={tr('scan')} hint={tr('scanFeatures')} colors={colors} reduceMotion={reduceMotion} onPress={() => void scanDocument()} />
              <Text style={styles.permissionHint}>{tr('cameraNote')}</Text>
            </View>}

            <View style={styles.homeLinks}>
              <Pressable accessibilityRole="button" onPress={() => void openHistory()} style={styles.homeLink}><Text style={styles.homeLinkIcon}>{'\u25F7'}</Text><Text style={styles.homeLinkText}>History</Text><Text style={styles.homeLinkArrow}>{'>'}</Text></Pressable>
              <Pressable accessibilityRole="button" onPress={() => setStage('settings')} style={styles.homeLink}><Text style={styles.homeLinkIcon}>{'\u2699'}</Text><Text style={styles.homeLinkText}>Settings</Text><Text style={styles.homeLinkArrow}>{'>'}</Text></Pressable>
            </View>
            <Text style={styles.footer}>JANSAATHI PLUS  ·  MADE FOR CLARITY</Text>
          </ScrollView>
        ) : stage === 'history' ? (
          <ScrollView contentContainerStyle={styles.historyContent}>
            <Text style={styles.workspaceTitle}>Your history</Text><Text style={styles.historyHint}>Documents uploaded in this device session</Text>
            {healthNote ? <View style={styles.notice}><Text style={styles.noticeText}>{healthNote}</Text></View> : null}
            {historyLoading ? reduceMotion ? <View style={[styles.loadingDot, { backgroundColor: colors.accent, alignSelf: 'center', marginTop: 36 }]} /> : <ActivityIndicator style={{ marginTop: 30 }} color={colors.accent} /> : history.length ? history.map(item => <Pressable key={item.id} onPress={() => void openHistoryDocument(item)} style={({ pressed }) => [styles.historyItem, pressed && styles.pressed]}>
              <View style={styles.historyIcon}><Text style={styles.historyIconText}>{item.file_type.slice(0, 3).toUpperCase()}</Text></View><View style={{ flex: 1 }}><Text style={styles.historyTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.historyMeta}>{new Date(item.created_at).toLocaleDateString()} | {item.status === 'completed' ? 'Ready to read' : 'Text extraction limited'}</Text></View><Text style={styles.homeLinkArrow}>{'>'}</Text>
            </Pressable>) : <Text style={styles.emptyHistory}>{healthNote || 'No uploaded documents yet.'}</Text>}
          </ScrollView>
        ) : stage === 'settings' ? (
          <ScrollView contentContainerStyle={styles.settingsContent}>
            <Text style={styles.workspaceTitle}>Settings</Text><Text style={styles.historyHint}>Language and appearance</Text>
            <View style={styles.settingsCard}>
              <Text style={styles.sectionEyebrow}>{tr('language').toUpperCase()}</Text>
              <View style={styles.segment}>{(['en', 'hi', 'gu'] as Language[]).map(code => <Pressable key={code} onPress={() => setLang(code)} style={[styles.segmentItem, language === code && styles.segmentActive]}><Text style={[styles.segmentText, language === code && styles.segmentTextActive]}>{languageNames[code]}</Text></Pressable>)}</View>
              <Text style={[styles.sectionEyebrow, { marginTop: 20 }]}>{tr('theme').toUpperCase()}</Text>
              <View style={styles.segment}>{(['system', 'light', 'dark'] as ThemeMode[]).map(mode => <Pressable key={mode} onPress={() => setTheme(mode)} style={[styles.segmentItem, themeMode === mode && styles.segmentActive]}><Text style={[styles.segmentText, themeMode === mode && styles.segmentTextActive]}>{tr(mode)}</Text></Pressable>)}</View>
            </View>
          </ScrollView>
        ) : stage === 'workspace' ? (
          <ScrollView contentContainerStyle={styles.workspaceContent}>
            <Text style={styles.sectionEyebrow}>{tr('yourDocument')}</Text><Text style={styles.workspaceTitle}>{document?.title || 'Document'}</Text>
            <View style={styles.metaRow}><View style={styles.metaPill}><Text style={styles.metaText}>{document?.file_type || 'FILE'}</Text></View><Text style={styles.metaText}>{document?.size ? `${(document.size / 1024 / 1024).toFixed(2)} MB` : ''}</Text></View>
            {document?.status === 'needs_ocr' || document?.status === 'no_text' ? <View style={styles.notice}><Text style={styles.noticeText}>{tr('noText')}</Text></View> : null}
            {document?.status === 'completed' && !overviewLocalized ? <View style={styles.notice}><Text style={styles.noticeText}>{tr('overviewFallback')}</Text></View> : null}
            <View style={styles.overviewCard}><View style={styles.overviewIcon}><Text style={styles.overviewIconText}>✳</Text></View><Text style={styles.overviewLabel}>{tr('about').toUpperCase()}</Text><Text style={styles.overviewHint}>{tr('aboutHint')}</Text><MarkdownContent value={document?.overview || tr('unknownOverview')} colors={colors}/></View>
            <View style={styles.carefulNote}><Text style={styles.noteIcon}>ⓘ</Text><Text style={styles.carefulText}>{tr('datesNote')}</Text></View>
            <Pressable style={styles.askCard} onPress={() => setStage('chat')}><LinearGradient colors={[colors.accent, colors.pink]} style={styles.askInner}><View><Text style={styles.askEyebrow}>{tr('askEyebrow')}</Text><Text style={styles.askTitle}>{tr('ask')}</Text><Text style={styles.askSubtitle}>{tr('askHint')}</Text></View><View style={styles.chatBubble}><Text style={styles.chatBubbleText}>↗</Text></View></LinearGradient></Pressable>
            <Pressable style={styles.secondary} onPress={() => { setStage('intake'); removeDraft(); }}><Text style={styles.secondaryText}>＋  {tr('upload')}</Text></Pressable>
          </ScrollView>
        ) : (
          <KeyboardAvoidingView style={styles.chatLayout} behavior="padding" keyboardVerticalOffset={insets.top + 68}>
            <View style={styles.chatHeader}><View style={styles.avatar}><Text style={styles.avatarText}>✳</Text></View><View style={{ flex: 1 }}><Text style={styles.chatTitle}>{tr('ask')}</Text><Text style={styles.chatSub}>{document?.title}</Text></View><View style={styles.contextBadge}><Text style={styles.contextBadgeText}>{tr('linked')}</Text></View></View>
            <View style={styles.chatIntro}><Text style={styles.chatIntroTitle}>{tr('chatPrompt')}</Text><Text style={styles.chatIntroBody}>{tr('source')} · {languageNames[language]}</Text></View>
            <FlatList style={styles.chatListView} ref={listRef} data={chatLines} keyExtractor={item => item.id} contentContainerStyle={styles.chatList} keyboardShouldPersistTaps="handled" keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'} onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })} ListFooterComponent={sending ? <ReanimatedAnimated.View entering={reduceMotion ? undefined : FadeInDown.duration(200)} exiting={reduceMotion ? undefined : FadeOutUp.duration(180)} style={styles.bubbleRow}><View style={[styles.messageBubble, styles.assistantBubble]}><ChatLoading colors={colors} label={tr('thinking')} reducedMotion={reduceMotion} /></View></ReanimatedAnimated.View> : undefined} renderItem={({ item }) => (
              <ReanimatedAnimated.View entering={reduceMotion ? undefined : FadeInDown.duration(220)} style={[styles.bubbleRow, item.role === 'user' && styles.bubbleRowUser]}><View style={[styles.messageBubble, item.role === 'user' ? styles.userBubble : item.role === 'error' ? styles.errorBubble : styles.assistantBubble]}>{item.role === 'assistant' ? <MarkdownContent value={item.text} colors={colors}/> : <Text style={[styles.messageText, item.role === 'user' && styles.userMessageText]}>{item.text}</Text>}{item.role === 'error' && item.failedQuestion ? <Pressable onPress={() => void sendMessage(item.failedQuestion)}><Text style={styles.retryText}>{tr('retry')} ↻</Text></Pressable> : null}</View></ReanimatedAnimated.View>
            )}/>
            <View style={styles.composer}><TextInput value={message} onChangeText={setMessage} placeholder={tr('question')} placeholderTextColor={colors.muted} multiline blurOnSubmit={false} maxLength={10000} textAlignVertical="top" style={styles.input}/><Pressable accessibilityRole="button" accessibilityLabel={tr('send')} disabled={!message.trim() || sending} onPress={() => void sendMessage()} style={[styles.sendButton, (!message.trim() || sending) && styles.sendDisabled]}><Text style={styles.sendGlyph}>↑</Text></Pressable></View>
            <Text style={styles.chatFoot}>{tr('disclaimer')}</Text>
          </KeyboardAvoidingView>
        )}
        </Animated.View>
      </View>
      <ProcessingModal visible={uploading || uploadComplete || !!uploadError || !!openingDocument} draft={openingDocument ? { uri: '', name: openingDocument.title, mime: openingDocument.mime_type, size: openingDocument.size } : draft} colors={colors} title={openingDocument ? tr('yourDocument') : uploadError ? tr('processingError') : uploadComplete ? tr('complete') : tr('processing')} status={openingDocument ? tr('preparing') : uploadComplete ? tr('complete') : processingMessage} progress={progress} success={uploadComplete} error={uploadError} reducedMotion={reduceMotion} retryLabel={tr('retry')} closeLabel={tr('back')} onRetry={() => { setUploadError(''); void uploadDraft(); }} onClose={() => setUploadError('')} />
    </SafeAreaView>
  );
}

function makeStyles(c: typeof palettes.dark) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: c.bg }, page: { flex: 1, backgroundColor: c.bg },
    topbar: { height: 68, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    brandMark: { width: 40, height: 40, borderRadius: 14, backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center', marginRight: 11 }, brandGlyph: { color: c.accent, fontSize: 22 }, brandText: { flex: 1 }, brand: { color: c.text, fontWeight: '800', fontSize: 17, letterSpacing: 0.2 }, plus: { color: c.pink, fontWeight: '700' }, brandTag: { color: c.muted, fontSize: 8, letterSpacing: 1.4, marginTop: 2 }, online: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6, borderRadius: 20 }, dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#65D5A2' }, onlineText: { color: c.muted, fontSize: 8, letterSpacing: 1 }, back: { paddingRight: 12, paddingVertical: 10 }, backText: { color: c.text, fontSize: 14, fontWeight: '600' },
    intakeContent: { padding: 20, paddingBottom: 34 }, homeIntro: { paddingTop: 25, paddingBottom: 27 },
    homeLinks: { marginTop: 2, marginBottom: 18, gap: 8 }, homeLink: { minHeight: 54, borderRadius: 16, paddingHorizontal: 14, backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, flexDirection: 'row', alignItems: 'center' }, homeLinkIcon: { color: c.accent, fontSize: 20, width: 34 }, homeLinkText: { flex: 1, color: c.text, fontSize: 13, fontWeight: '700' }, homeLinkArrow: { color: c.muted, fontSize: 24 },
    historyContent: { padding: 21, paddingTop: 27, paddingBottom: 36 }, settingsContent: { padding: 21, paddingTop: 27, paddingBottom: 36 }, historyHint: { color: c.muted, fontSize: 12, lineHeight: 18, marginTop: 6, marginBottom: 22 }, historyItem: { minHeight: 76, borderRadius: 17, paddingHorizontal: 13, marginBottom: 10, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, flexDirection: 'row', alignItems: 'center' }, historyIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, historyIconText: { color: c.accent, fontSize: 10, fontWeight: '800' }, historyTitle: { color: c.text, fontSize: 13, fontWeight: '700' }, historyMeta: { color: c.muted, fontSize: 10, marginTop: 5 }, emptyHistory: { color: c.muted, fontSize: 13, lineHeight: 20, marginTop: 18 }, hero: { padding: 23, minHeight: 206, borderRadius: 24, overflow: 'hidden', borderWidth: 1, borderColor: c.border, marginBottom: 28 }, heroGlow: { position: 'absolute', width: 180, height: 180, borderRadius: 90, backgroundColor: '#B55EF0', opacity: 0.14, right: -46, top: -64 }, eyebrow: { color: c.pink, fontSize: 9, fontWeight: '800', letterSpacing: 1.6 }, heroTitle: { color: c.text, fontSize: 26, fontWeight: '800', marginTop: 13, maxWidth: '76%', lineHeight: 32 }, heroBody: { color: c.muted, fontSize: 13, lineHeight: 20, marginTop: 8, maxWidth: '82%' }, heroGlyph: { position: 'absolute', right: 20, top: 72, width: 63, height: 63, borderRadius: 20, backgroundColor: 'rgba(199,125,255,0.15)', borderColor: 'rgba(210,160,255,0.24)', borderWidth: 1, alignItems: 'center', justifyContent: 'center', transform: [{ rotate: '8deg' }] }, heroGlyphText: { color: '#E2B8FF', fontSize: 36 }, trust: { color: c.muted, fontSize: 10, marginTop: 17 }, dotInline: { color: '#65D5A2', fontSize: 8 }, actions: { marginBottom: 27 }, sectionEyebrow: { color: c.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1.5, marginBottom: 12 }, actionCard: { minHeight: 80, borderRadius: 19, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface, padding: 15, flexDirection: 'row', alignItems: 'center', marginBottom: 11 }, pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] }, actionIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center', marginRight: 13 }, actionGlyph: { color: c.accent, fontSize: 26, fontWeight: '600' }, actionTitle: { color: c.text, fontSize: 14, fontWeight: '700' }, actionSubtitle: { color: c.muted, fontSize: 9, letterSpacing: 0.7, marginTop: 5 }, actionArrow: { color: c.muted, fontSize: 26, paddingLeft: 8 }, scanCard: { height: 80, borderRadius: 19, overflow: 'hidden', borderWidth: 1, borderColor: c.border }, scanGradient: { flex: 1, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center' }, scanIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: 'rgba(183,105,247,0.16)', alignItems: 'center', justifyContent: 'center', marginRight: 13 }, scanGlyph: { color: '#D5A5FF', fontSize: 24 }, scanTitle: { color: '#F6F0FC', fontSize: 14, fontWeight: '700' }, scanSubtitle: { color: '#B8ADC6', fontSize: 9, marginTop: 5 }, scanArrow: { color: '#D49AFF', fontSize: 21, paddingLeft: 10 }, permissionHint: { color: c.muted, fontSize: 10, lineHeight: 16, paddingHorizontal: 2, marginTop: 10 },
    settingsCard: { padding: 17, backgroundColor: c.surface, borderRadius: 19, borderColor: c.border, borderWidth: 1 }, segment: { flexDirection: 'row', padding: 3, borderRadius: 13, backgroundColor: c.bg, gap: 3 }, segmentItem: { flex: 1, minHeight: 38, paddingHorizontal: 6, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, segmentActive: { backgroundColor: c.surface2, borderWidth: 1, borderColor: c.border }, segmentText: { color: c.muted, fontSize: 11, fontWeight: '600' }, segmentTextActive: { color: c.text }, footer: { textAlign: 'center', color: c.muted, letterSpacing: 1.4, fontSize: 8, marginTop: 24 },
    notice: { backgroundColor: c.surface2, borderRadius: 13, padding: 12, borderWidth: 1, borderColor: c.border, marginBottom: 15 }, noticeText: { color: c.muted, fontSize: 12, lineHeight: 18 }, draftCard: { backgroundColor: c.surface, borderRadius: 20, borderWidth: 1, borderColor: c.border, padding: 15, marginBottom: 20 }, draftTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, removeText: { color: c.danger, fontSize: 12, fontWeight: '700' }, replaceRow: { alignItems: 'flex-end', marginTop: -4, marginBottom: 12 }, replaceText: { color: c.accent, fontSize: 11, fontWeight: '700' }, preview: { width: '100%', height: 190, borderRadius: 13, backgroundColor: c.bg, marginBottom: 14 }, filePreview: { height: 120, borderRadius: 13, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }, pdfGlyph: { color: c.accent, fontSize: 28, fontWeight: '900', letterSpacing: 2 }, fileName: { color: c.text, fontSize: 13, fontWeight: '700' }, fileInfo: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 }, fileIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center', marginRight: 11 }, fileIconText: { color: c.accent, fontWeight: '800', fontSize: 9 }, fileMeta: { color: c.muted, fontSize: 10, marginTop: 4 }, rotate: { alignItems: 'center', paddingLeft: 8 }, rotateText: { color: c.accent, fontSize: 25, lineHeight: 26 }, rotateLabel: { color: c.muted, fontSize: 8 }, primary: { borderRadius: 14, overflow: 'hidden' }, primaryInner: { height: 49, alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#1B1025', fontWeight: '800', fontSize: 13 }, loadingDot: { width: 9, height: 9, borderRadius: 5 }, uploading: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 }, uploadTitle: { color: c.text, fontSize: 12, fontWeight: '700' }, uploadHint: { color: c.muted, fontSize: 10, marginTop: 3 }, progressTrack: { height: 4, backgroundColor: c.surface2, borderRadius: 4, overflow: 'hidden' }, progressFill: { height: 4, backgroundColor: c.accent }, retryRow: { paddingTop: 9 }, retryText: { color: c.accent, fontSize: 12, fontWeight: '700', marginTop: 7 },
    workspaceContent: { padding: 21, paddingBottom: 36 }, workspaceTitle: { color: c.text, fontSize: 24, fontWeight: '800', lineHeight: 30 }, metaRow: { flexDirection: 'row', gap: 9, alignItems: 'center', marginTop: 10, marginBottom: 22 }, metaPill: { backgroundColor: c.surface2, paddingHorizontal: 9, paddingVertical: 5, borderRadius: 8 }, metaText: { color: c.muted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 }, overviewCard: { backgroundColor: c.surface, borderRadius: 20, borderWidth: 1, borderColor: c.border, padding: 18 }, overviewIcon: { width: 39, height: 39, backgroundColor: c.surface2, borderRadius: 13, justifyContent: 'center', alignItems: 'center', marginBottom: 17 }, overviewIconText: { color: c.accent, fontSize: 22 }, overviewLabel: { color: c.pink, fontSize: 9, fontWeight: '800', letterSpacing: 1.3 }, overviewHint: { color: c.muted, fontSize: 10, marginTop: 6 }, overviewText: { color: c.text, fontSize: 16, lineHeight: 25, marginTop: 16 }, carefulNote: { flexDirection: 'row', gap: 9, paddingHorizontal: 4, marginTop: 17, marginBottom: 25 }, noteIcon: { color: c.accent, fontSize: 15 }, carefulText: { flex: 1, color: c.muted, fontSize: 11, lineHeight: 17 }, askCard: { borderRadius: 20, overflow: 'hidden' }, askInner: { minHeight: 125, padding: 19, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, askEyebrow: { color: 'rgba(255,255,255,0.76)', fontSize: 8, letterSpacing: 1.3, fontWeight: '800' }, askTitle: { color: '#FFF', fontSize: 20, fontWeight: '800', marginTop: 9 }, askSubtitle: { color: 'rgba(255,255,255,0.82)', fontSize: 11, marginTop: 4 }, chatBubble: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.2)', alignItems: 'center', justifyContent: 'center' }, chatBubbleText: { color: '#FFF', fontSize: 22 }, secondary: { marginTop: 14, minHeight: 47, borderWidth: 1, borderColor: c.border, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: c.text, fontSize: 12, fontWeight: '700' },
    chatLayout: { flex: 1 }, chatHeader: { height: 72, paddingHorizontal: 17, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderColor: c.border, gap: 11 }, avatar: { width: 40, height: 40, borderRadius: 15, backgroundColor: c.surface2, alignItems: 'center', justifyContent: 'center' }, avatarText: { color: c.accent, fontSize: 23 }, chatTitle: { color: c.text, fontSize: 14, fontWeight: '800' }, chatSub: { color: c.muted, fontSize: 10, marginTop: 3 }, contextBadge: { borderRadius: 7, paddingHorizontal: 7, paddingVertical: 5, backgroundColor: c.surface2 }, contextBadgeText: { color: c.accent, fontSize: 7, letterSpacing: 0.7, fontWeight: '800' }, chatIntro: { paddingHorizontal: 19, paddingTop: 17, paddingBottom: 10 }, chatIntroTitle: { color: c.text, fontSize: 16, fontWeight: '700' }, chatIntroBody: { color: c.muted, fontSize: 10, marginTop: 5, lineHeight: 15 }, chatListView: { width: '100%' }, chatList: { flexGrow: 1, width: '100%', paddingHorizontal: 15, paddingVertical: 12 }, bubbleRow: { width: '100%', alignItems: 'flex-start', marginVertical: 5 }, bubbleRowUser: { alignItems: 'flex-end' }, messageBubble: { maxWidth: '88%', paddingHorizontal: 13, paddingVertical: 11, borderRadius: 16 }, assistantBubble: { width: '100%', maxWidth: '100%', backgroundColor: c.surface, borderColor: c.border, borderWidth: 1, borderTopLeftRadius: 5 }, userBubble: { backgroundColor: c.accent, borderTopRightRadius: 5 }, errorBubble: { backgroundColor: c.surface2, borderColor: c.danger, borderWidth: 1 }, messageText: { color: c.text, fontSize: 13, lineHeight: 20 }, userMessageText: { color: '#FFF' }, thinking: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 9, gap: 9 }, thinkingText: { color: c.muted, fontSize: 11 }, composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: 1, borderColor: c.border }, input: { flex: 1, minHeight: 44, maxHeight: 120, paddingHorizontal: 14, paddingTop: 12, paddingBottom: 10, borderRadius: 15, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, color: c.text, fontSize: 13 }, sendButton: { width: 43, height: 43, borderRadius: 15, backgroundColor: c.accent, alignItems: 'center', justifyContent: 'center' }, sendDisabled: { opacity: 0.45 }, sendGlyph: { color: '#FFF', fontSize: 22, fontWeight: '700' }, chatFoot: { color: c.muted, fontSize: 9, textAlign: 'center', paddingHorizontal: 16, paddingBottom: 7 },
  });
}
