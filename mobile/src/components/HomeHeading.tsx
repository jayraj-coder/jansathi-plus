import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  cancelAnimation, Easing, FadeInDown, interpolateColor, ReduceMotion, useAnimatedStyle,
  useReducedMotion, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import type { palettes } from '../theme';
import { useAppActive } from '../hooks/useAppActive';

type Colors = typeof palettes.dark;

export function HomeHeading({ colors, reduceMotion, subtitle }: { colors: Colors; reduceMotion: boolean; subtitle: string }) {
  const progress = useSharedValue(0);
  const systemReduceMotion = useReducedMotion();
  const appActive = useAppActive();
  const first = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 0.5, 1], [colors.accent, colors.pink, colors.accent]) }));
  const second = useAnimatedStyle(() => ({ color: interpolateColor(progress.value, [0, 0.5, 1], [colors.pink, colors.accent, colors.pink]) }));
  useEffect(() => {
    if (!appActive || systemReduceMotion || reduceMotion) { cancelAnimation(progress); return; }
    // Starting a UI-thread animation inside an effect is intentional.
    // eslint-disable-next-line react-hooks/immutability
    progress.value = withRepeat(withTiming(1, { duration: 5200, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }), -1, true);
    return () => cancelAnimation(progress);
  }, [appActive, progress, reduceMotion, systemReduceMotion]);
  const motionDisabled = reduceMotion || systemReduceMotion;
  return <View style={styles.wrap}>
    <Animated.View entering={motionDisabled ? undefined : FadeInDown.duration(320)}>
      <Animated.Text accessibilityRole="header" style={[styles.line, { color: colors.text }]}><Animated.Text style={motionDisabled ? { color: colors.accent } : first}>Your</Animated.Text><Animated.Text style={motionDisabled ? { color: colors.pink } : second}> documents,</Animated.Text></Animated.Text>
      <Animated.Text style={[styles.line, { color: colors.text }]}><Animated.Text style={motionDisabled ? { color: colors.pink } : second}>clearly</Animated.Text><Animated.Text style={motionDisabled ? { color: colors.accent } : first}> understood.</Animated.Text></Animated.Text>
    </Animated.View>
    <Animated.Text entering={motionDisabled ? undefined : FadeInDown.delay(90).duration(350)} style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Animated.Text>
  </View>;
}

const styles = StyleSheet.create({
  wrap: { paddingTop: 31, paddingBottom: 32, alignItems: 'center' },
  line: { textAlign: 'center', fontSize: 29, lineHeight: 36, fontWeight: '800', letterSpacing: -0.65 },
  subtitle: { textAlign: 'center', fontSize: 13, lineHeight: 20, marginTop: 12, maxWidth: 300 },
});
