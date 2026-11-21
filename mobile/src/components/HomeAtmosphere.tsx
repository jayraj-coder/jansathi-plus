import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Animated, {
  cancelAnimation, Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming,
} from 'react-native-reanimated';
import { palettes } from '../theme';
import { useAppActive } from '../hooks/useAppActive';

type Colors = typeof palettes.dark;
type Dot = { x: `${number}%`; y: `${number}%`; size: number; dx: number; dy: number; duration: number; delay: number; tone: 'accent' | 'pink' };
const DOTS: Dot[] = [
  { x: '9%', y: '16%', size: 4, dx: 13, dy: -19, duration: 5200, delay: 0, tone: 'accent' },
  { x: '89%', y: '23%', size: 6, dx: -16, dy: 22, duration: 6100, delay: 420, tone: 'pink' },
  { x: '22%', y: '43%', size: 3, dx: 10, dy: -17, duration: 4800, delay: 900, tone: 'pink' },
  { x: '78%', y: '53%', size: 4, dx: -11, dy: -24, duration: 6500, delay: 180, tone: 'accent' },
  { x: '12%', y: '73%', size: 5, dx: 15, dy: 18, duration: 5700, delay: 1100, tone: 'pink' },
  { x: '91%', y: '82%', size: 3, dx: -12, dy: -16, duration: 5000, delay: 600, tone: 'accent' },
  { x: '52%', y: '12%', size: 3, dx: 8, dy: 15, duration: 6300, delay: 1400, tone: 'pink' },
  { x: '61%', y: '69%', size: 5, dx: -15, dy: -13, duration: 5900, delay: 300, tone: 'accent' },
];

function Particle({ dot, active, reduceMotion, colors }: { dot: Dot; active: boolean; reduceMotion: boolean; colors: Colors }) {
  const phase = useSharedValue(0);
  useEffect(() => {
    cancelAnimation(phase);
    if (!active || reduceMotion) { phase.value = 0; return; }
    phase.value = withDelay(dot.delay, withRepeat(
      withTiming(1, { duration: dot.duration, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
      -1, true,
    ));
    return () => cancelAnimation(phase);
  }, [active, dot, phase, reduceMotion]);
  const style = useAnimatedStyle(() => ({
    opacity: reduceMotion ? 0.2 : 0.1 + Math.sin(phase.value * Math.PI) * 0.28,
    transform: [{ translateX: phase.value * dot.dx }, { translateY: phase.value * dot.dy }],
  }));
  const color = dot.tone === 'pink' ? colors.pink : colors.accent;
  return <Animated.View pointerEvents="none" style={[styles.particle, { left: dot.x, top: dot.y, width: dot.size, height: dot.size, borderRadius: dot.size / 2, backgroundColor: color, shadowColor: color }, style]} />;
}

export function HomeAtmosphere({ colors, active, reduceMotion }: { colors: Colors; active: boolean; reduceMotion: boolean }) {
  const foreground = useAppActive();
  const animate = active && foreground && !reduceMotion;
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <LinearGradient pointerEvents="none" colors={[colors.bg, colors.surface, colors.bg]} style={StyleSheet.absoluteFill} />
    <View style={[styles.ambient, styles.ambientOne, { backgroundColor: colors.accent, opacity: colors.bg === palettes.dark.bg ? 0.045 : 0.025 }]} />
    <View style={[styles.ambient, styles.ambientTwo, { backgroundColor: colors.pink, opacity: colors.bg === palettes.dark.bg ? 0.035 : 0.018 }]} />
    {DOTS.map((dot, index) => <Particle key={index} dot={dot} active={animate} reduceMotion={reduceMotion} colors={colors} />)}
  </View>;
}

const styles = StyleSheet.create({
  ambient: { position: 'absolute', width: 230, height: 230, borderRadius: 120 },
  ambientOne: { top: '13%', right: '-35%' }, ambientTwo: { bottom: '14%', left: '-38%', width: 190, height: 190 },
  particle: { position: 'absolute', shadowOpacity: 0.3, shadowRadius: 5 },
});
