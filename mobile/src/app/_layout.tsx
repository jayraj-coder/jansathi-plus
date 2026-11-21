import { Stack } from 'expo-router';
import { useColorScheme } from 'react-native';
import { palettes } from '../theme';
import { SafeAreaProvider } from 'react-native-safe-area-context';

export default function RootLayout() {
  const isLight = useColorScheme() === 'light';
  const color = isLight ? palettes.light : palettes.dark;
  return <SafeAreaProvider><Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.bg }, animation: 'fade_from_bottom' }} /></SafeAreaProvider>;
}
