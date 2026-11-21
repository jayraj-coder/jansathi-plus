import React, { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue,
  withRepeat, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import type { palettes } from '../theme';
import { useAppActive } from '../hooks/useAppActive';

type Colors = typeof palettes.dark;
type Props = { kind: 'upload' | 'scan'; title: string; hint: string; colors: Colors; reduceMotion: boolean; onPress: () => void };

export function AnimatedAction({ kind, title, hint, colors, reduceMotion: appReduceMotion, onPress }: Props) {
  const systemReduceMotion = useReducedMotion();
  const reduceMotion = appReduceMotion || systemReduceMotion;
  const appActive = useAppActive();
  const float = useSharedValue(0);
  const pulse = useSharedValue(0);
  const press = useSharedValue(1);
  const scan = kind === 'scan';

  useEffect(() => {
    if (reduceMotion || !appActive) { float.value = 0; pulse.value = 0; return; }
    float.value = withRepeat(withSequence(
      withTiming(-4, { duration: 1500, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
      withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
    ), -1, false);
    pulse.value = withRepeat(withSequence(
      withTiming(1, { duration: 1250, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
      withTiming(0, { duration: 1250, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
    ), -1, false);
    return () => { float.value = 0; pulse.value = 0; };
  }, [appActive, float, pulse, reduceMotion]);

  const floatStyle = useAnimatedStyle(() => ({ transform: [{ translateY: float.value }] }));
  const ringStyle = useAnimatedStyle(() => ({ opacity: 0.35 + pulse.value * 0.35, transform: [{ scale: 0.94 + pulse.value * 0.06 }] }));
  const pressStyle = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));
  const scanStyle = useAnimatedStyle(() => ({ transform: [{ translateY: pulse.value * 13 - 6 }] }));
  const glow = scan ? colors.pink : colors.accent;

  return <Animated.View style={[styles.outer, pressStyle]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${title}. ${hint}`} onPress={onPress}
      // Reanimated shared values are intentionally mutated from native press callbacks.
      // eslint-disable-next-line react-hooks/immutability
      onPressIn={() => { if (!reduceMotion) press.value = withSpring(0.975, { damping: 16, stiffness: 260, reduceMotion: ReduceMotion.System }); }}
      // eslint-disable-next-line react-hooks/immutability
      onPressOut={() => { if (!reduceMotion) press.value = withSpring(1, { damping: 13, stiffness: 220, reduceMotion: ReduceMotion.System }); }}>
      <LinearGradient colors={[colors.surface, colors.surface2]} style={[styles.card, { borderColor: colors.border }]}>
        <Animated.View pointerEvents="none" style={[styles.ring, { borderColor: glow }, ringStyle]} />
        <Animated.View style={[styles.iconWrap, floatStyle, { backgroundColor: colors.surface2 }]}>
          <View style={[styles.glow, { backgroundColor: glow }]} />
          {scan ? <>
            <View style={[styles.bracket, styles.tl, { borderColor: glow }]} /><View style={[styles.bracket, styles.tr, { borderColor: glow }]} />
            <View style={[styles.bracket, styles.bl, { borderColor: glow }]} /><View style={[styles.bracket, styles.br, { borderColor: glow }]} />
            <Text style={[styles.glyph, { color: colors.text }]}>▣</Text>
            <Animated.View style={[styles.scanLine, { backgroundColor: glow }, scanStyle]} />
          </> : <><Text style={[styles.glyph, { color: colors.text }]}>＋</Text><Text style={[styles.uploadArrow, { color: glow }]}>↑</Text></>}
        </Animated.View>
        <View style={styles.copy}><Text style={[styles.title, { color: colors.text }]}>{title}</Text><Text style={[styles.hint, { color: colors.muted }]}>{hint}</Text></View>
        <Text style={[styles.chevron, { color: colors.muted }]}>›</Text>
      </LinearGradient>
    </Pressable>
  </Animated.View>;
}

const styles = StyleSheet.create({
  outer: { marginBottom: 13 }, card: { minHeight: 96, borderRadius: 22, borderWidth: 1, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  ring: { position: 'absolute', left: 12, width: 68, height: 68, borderRadius: 22, borderWidth: 1 },
  iconWrap: { width: 58, height: 58, borderRadius: 19, alignItems: 'center', justifyContent: 'center', marginRight: 15, overflow: 'hidden' },
  glow: { position: 'absolute', width: 40, height: 40, borderRadius: 20, opacity: 0.13 },
  glyph: { fontSize: 28, lineHeight: 34, fontWeight: '600' }, uploadArrow: { position: 'absolute', top: 3, right: 7, fontSize: 16, fontWeight: '800' },
  bracket: { position: 'absolute', width: 10, height: 10 }, tl: { left: 8, top: 8, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: 3 },
  tr: { right: 8, top: 8, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: 3 },
  bl: { left: 8, bottom: 8, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: 3 },
  br: { right: 8, bottom: 8, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: 3 },
  scanLine: { position: 'absolute', width: 34, height: 2, borderRadius: 2, opacity: 0.7 },
  copy: { flex: 1 }, title: { fontSize: 15, fontWeight: '700' }, hint: { fontSize: 11, marginTop: 5, lineHeight: 16 }, chevron: { fontSize: 27, paddingLeft: 9 },
});
