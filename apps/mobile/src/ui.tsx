import type { ReactNode } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
export const colors = { paper: '#F5F3EC', ink: '#192D23', muted: '#626F66', lime: '#DAF76B', line: '#D7DBD0', white: '#FCFBF7', error: '#8B302A' };
export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper }, content: { padding: 22, gap: 18, paddingBottom: 36 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  card: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, borderRadius: 18, padding: 20, gap: 14 },
  title: { fontSize: 34, lineHeight: 39, letterSpacing: -1.1, color: colors.ink, fontWeight: '600' },
  heading: { fontSize: 21, lineHeight: 28, color: colors.ink, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 23, color: colors.ink }, caption: { fontSize: 12, lineHeight: 19, color: colors.muted },
  label: { fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase', color: colors.muted, fontWeight: '600' },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 10, padding: 14, minHeight: 48, color: colors.ink, backgroundColor: colors.paper, fontSize: 16 },
  button: { borderRadius: 28, backgroundColor: colors.ink, paddingHorizontal: 20, paddingVertical: 15, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  secondary: { backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  buttonText: { color: colors.white, fontSize: 14, fontWeight: '600' },
  notice: { backgroundColor: '#E9EDDC', borderRadius: 10, padding: 14 },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: 8 },
});
export function Copy({ children, small = false }: { children: ReactNode; small?: boolean }) { return <Text selectable style={small ? s.caption : s.body}>{children}</Text>; }
export function Title({ children }: { children: ReactNode }) { return <Text style={s.title}>{children}</Text>; }
export function Heading({ children }: { children: ReactNode }) { return <Text style={s.heading}>{children}</Text>; }
export function Card({ children }: { children: ReactNode }) { return <View style={s.card}>{children}</View>; }
export function Button({ title, onPress, disabled, secondary }: { title: string; onPress: () => void; disabled?: boolean; secondary?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [s.button, secondary && s.secondary, { opacity: disabled ? 0.45 : pressed ? 0.7 : 1 }]}><Text style={[s.buttonText, secondary && { color: colors.ink }]}>{title}</Text></Pressable>;
}
export function Notice({ children }: { children: ReactNode }) { return children ? <View accessibilityLiveRegion="polite" style={s.notice}><Copy>{children}</Copy></View> : null; }
export function Field({ label, value, onChange, numeric, multiline }: { label: string; value: string; onChange: (s: string) => void; numeric?: boolean; multiline?: boolean }) {
  return <View style={{ gap: 7 }}><Copy small>{label}</Copy><TextInput accessibilityLabel={label} style={s.input} value={value} onChangeText={onChange} keyboardType={numeric ? 'decimal-pad' : 'default'} multiline={multiline} autoCorrect={false} autoCapitalize="none" /></View>;
}
export function Choice<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return <View style={s.row}>{options.map(o => <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: value === o.value }} onPress={() => onChange(o.value)} style={[s.button, value !== o.value && s.secondary]}><Text style={[s.buttonText, value !== o.value && { color: colors.ink }]}>{o.label}</Text></Pressable>)}</View>;
}
export function External({ title, url }: { title: string; url: string }) {
  return <Button secondary title={title} onPress={() => { if (/^https:\/\//.test(url)) void Linking.openURL(url).catch(() => undefined); }} />;
}
