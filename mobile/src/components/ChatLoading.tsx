import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, interpolate, ReduceMotion, useAnimatedStyle, useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import type { palettes } from '../theme';
import { useAppActive } from '../hooks/useAppActive';

type Colors = typeof palettes.dark;

export function ChatLoading({ colors, label, reducedMotion = false }: { colors: Colors; label: string; reducedMotion?: boolean }) {
  const phase = useSharedValue(0);
  const systemReduceMotion = useReducedMotion();
  const motionDisabled = reducedMotion || systemReduceMotion;
  const appActive = useAppActive();
  useEffect(() => {
    if (motionDisabled || !appActive) { phase.value = 0; return; }
    phase.value = withRepeat(withTiming(1, { duration: 1450, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }), -1, true);
    return () => { phase.value = 0; };
  }, [appActive, motionDisabled, phase]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.2 + phase.value * 0.38, transform: [{ scale: 0.82 + phase.value * 0.32 }] }));
  const orb = useAnimatedStyle(() => ({ transform: [{ scale: 0.94 + phase.value * 0.08 }] }));
  const dotA = useAnimatedStyle(() => ({ opacity: 0.28 + interpolate(phase.value, [0, 0.5, 1], [0, 1, 0]) * 0.7 }));
  const dotB = useAnimatedStyle(() => ({ opacity: 0.28 + interpolate(phase.value, [0, 0.5, 1], [1, 0, 0.2]) * 0.7 }));
  const dotC = useAnimatedStyle(() => ({ opacity: 0.28 + interpolate(phase.value, [0, 0.5, 1], [0.1, 0, 1]) * 0.7 }));
  return <View accessibilityLiveRegion="polite" style={styles.row}>
    <View style={styles.symbol}>
      <Animated.View style={[styles.ring, { borderColor: colors.accent }, ring]} />
      <Animated.View style={[styles.orb, { backgroundColor: colors.surface2, borderColor: colors.border }, orb]}><Text style={{ color: colors.accent, fontSize: 19 }}>✦</Text></Animated.View>
    </View>
    <View style={styles.copy}><Text style={[styles.label, { color: colors.muted }]}>{label}</Text><View style={styles.dots}>
      <Animated.View style={[styles.dot, { backgroundColor: colors.accent }, dotA]} /><Animated.View style={[styles.dot, { backgroundColor: colors.pink }, dotB]} /><Animated.View style={[styles.dot, { backgroundColor: colors.accent }, dotC]} />
    </View></View>
  </View>;
}

const styles = StyleSheet.create({
  row: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12 },
  symbol: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: 32, height: 32, borderRadius: 16, borderWidth: 1 },
  orb: { width: 24, height: 24, borderRadius: 10, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1 }, label: { fontSize: 12, lineHeight: 18, fontWeight: '600' }, dots: { flexDirection: 'row', gap: 4, marginTop: 3 }, dot: { width: 4, height: 4, borderRadius: 2 },
});
