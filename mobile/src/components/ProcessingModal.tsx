import React, { useEffect } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, FadeInDown, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import type { palettes } from '../theme';
import { useAppActive } from '../hooks/useAppActive';
type Draft = { uri: string; name: string; mime: string; size?: number; preview?: string; scanned?: boolean };

type Colors = typeof palettes.dark;
type Props = {
  visible: boolean; draft: Draft | null; colors: Colors; title?: string; status: string; progress: number | null;
  success: boolean; error: string; reducedMotion?: boolean; retryLabel: string; closeLabel: string; onRetry: () => void; onClose: () => void;
};

export function ProcessingModal({ visible, draft, colors, title, status, progress, success, error, reducedMotion = false, retryLabel, closeLabel, onRetry, onClose }: Props) {
  const phase = useSharedValue(0);
  const systemReduceMotion = useReducedMotion();
  const motionDisabled = reducedMotion || systemReduceMotion;
  const appActive = useAppActive();
  useEffect(() => {
    if (motionDisabled || !visible || !appActive) { phase.value = 0; return; }
    phase.value = withRepeat(withTiming(1, { duration: 1600, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }), -1, true);
    return () => { phase.value = 0; };
  }, [appActive, motionDisabled, phase, visible]);
  const halo = useAnimatedStyle(() => ({ opacity: 0.15 + phase.value * 0.22, transform: [{ scale: 0.9 + phase.value * 0.16 }] }));
  const progressStyle = useAnimatedStyle(() => ({ transform: [{ translateX: -110 + phase.value * 220 }] }));
  return <Modal transparent visible={visible} animationType="fade" statusBarTranslucent onRequestClose={error ? onClose : () => {}}>
    <View style={styles.scrim}>
      <Animated.View entering={motionDisabled ? undefined : FadeInDown.duration(240)} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={styles.art}>
          <Animated.View style={[styles.halo, { backgroundColor: colors.accent }, halo]} />
          <View style={[styles.document, { backgroundColor: colors.surface2, borderColor: colors.border }]}><Text style={[styles.documentGlyph, { color: colors.accent }]}>▤</Text><View style={[styles.documentFold, { borderColor: colors.accent }]} /></View>
          {success ? <Text style={[styles.successMark, { color: colors.accent }]}>✓</Text> : error ? <Text style={[styles.errorMark, { color: colors.danger }]}>!</Text> : motionDisabled ? <View style={[styles.staticDot, { backgroundColor: colors.pink }]} /> : <ActivityIndicator style={styles.spinner} size="small" color={colors.pink} />}
        </View>
        <Text style={[styles.title, { color: colors.text }]}>{title || (success ? 'Your document is ready' : error ? 'Could not finish processing' : 'Working on your document')}</Text>
        <Text style={[styles.filename, { color: colors.text }]} numberOfLines={1}>{draft?.name}</Text>
        <Text style={[styles.metadata, { color: colors.muted }]}>{draft?.name.split('.').pop()?.toUpperCase() || draft?.mime.split('/').pop()?.toUpperCase() || 'FILE'}{draft?.size ? `  ·  ${(draft.size / 1024 / 1024).toFixed(2)} MB` : ''}</Text>
        <Text style={[styles.status, { color: error ? colors.danger : colors.muted }]}>{error || status}</Text>
        {!success && !error ? <View style={[styles.track, { backgroundColor: colors.surface2 }]}>
          {progress !== null ? <View style={[styles.fill, { backgroundColor: colors.accent, width: `${progress}%` }]} /> : motionDisabled ? <View style={[styles.indeterminateStatic, { backgroundColor: colors.accent }]} /> : <Animated.View style={[styles.indeterminate, { backgroundColor: colors.accent }, progressStyle]} />}
        </View> : null}
        {error ? <View style={styles.buttons}>
          <Pressable onPress={onClose} style={[styles.button, { borderColor: colors.border }]}><Text style={[styles.buttonText, { color: colors.muted }]}>{closeLabel}</Text></Pressable>
          <Pressable onPress={onRetry} style={[styles.button, styles.primary, { backgroundColor: colors.accent }]}><Text style={[styles.buttonText, { color: colors.onAccent }]}>{retryLabel}</Text></Pressable>
        </View> : null}
      </Animated.View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(9,6,15,0.62)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { width: '100%', maxWidth: 380, borderWidth: 1, borderRadius: 26, paddingHorizontal: 22, paddingTop: 23, paddingBottom: 22, alignItems: 'center' },
  art: { width: 80, height: 76, alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  halo: { position: 'absolute', width: 70, height: 70, borderRadius: 35 },
  document: { width: 46, height: 56, borderRadius: 12, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  documentGlyph: { fontSize: 25, fontWeight: '700' }, documentFold: { position: 'absolute', top: 10, right: 8, width: 9, height: 9, borderTopWidth: 1, borderRightWidth: 1 },
  spinner: { position: 'absolute', right: 6, bottom: 6, backgroundColor: 'transparent' }, staticDot: { position: 'absolute', right: 10, bottom: 10, width: 8, height: 8, borderRadius: 4 }, successMark: { position: 'absolute', right: 4, bottom: 1, fontSize: 22, fontWeight: '800' }, errorMark: { position: 'absolute', right: 4, bottom: 1, fontSize: 22, fontWeight: '800' },
  title: { fontSize: 18, lineHeight: 24, fontWeight: '800', textAlign: 'center' }, filename: { fontSize: 13, lineHeight: 19, fontWeight: '700', marginTop: 13, maxWidth: '100%' },
  metadata: { fontSize: 10, lineHeight: 15, marginTop: 3 }, status: { fontSize: 12, lineHeight: 18, textAlign: 'center', marginTop: 16, marginBottom: 11 },
  track: { width: '100%', height: 4, borderRadius: 4, overflow: 'hidden' }, fill: { height: '100%', borderRadius: 4 }, indeterminate: { width: 90, height: 4, borderRadius: 4 }, indeterminateStatic: { position: 'absolute', left: '34%', width: '32%', height: 4, borderRadius: 4 },
  buttons: { flexDirection: 'row', width: '100%', gap: 10, marginTop: 8 }, button: { flex: 1, minHeight: 44, borderRadius: 13, borderWidth: 1, alignItems: 'center', justifyContent: 'center' }, primary: { borderWidth: 0 }, buttonText: { fontSize: 13, fontWeight: '700' },
});
