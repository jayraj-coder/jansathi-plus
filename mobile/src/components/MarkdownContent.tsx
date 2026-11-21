import React from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import type { palettes } from '../theme';

type Colors = typeof palettes.dark;

function clean(value: string) {
  return value
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]*>/g, '');
}

const DATE_TOKEN = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)`;
const INLINE_TOKEN = new RegExp(String.raw`(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\x60[^\x60]+\x60|!\[[^\]]*\]\([^)]+\)|\[[^\]]+\]\([^)]+\)|${DATE_TOKEN})`, 'gi');

function inline(text: string, colors: Colors, keyPrefix: string): React.ReactNode[] {
  return clean(text).split(INLINE_TOKEN).filter(Boolean).map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    const image = part.match(/^!\[([^\]]*)\]\([^)]+\)$/);
    if (image) return <Text key={key}>{image[1]}</Text>;
    const link = part.match(/^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/i);
    if (link) return <Text key={key} accessibilityRole="link" onPress={() => { void Linking.openURL(link[2]).catch(() => {}); }} style={{ color: colors.accent, textDecorationLine: 'underline' }}>{link[1]}</Text>;
    const label = part.match(/^\[([^\]]+)\]\([^)]+\)$/);
    if (label) return <Text key={key} style={{ color: colors.accent }}>{label[1]}</Text>;
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__')))
      return <Text key={key} style={{ fontWeight: '700', color: colors.text }}>{part.slice(2, -2)}</Text>;
    if ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))
      return <Text key={key} style={{ fontStyle: 'italic' }}>{part.slice(1, -1)}</Text>;
    if (part.startsWith('~~') && part.endsWith('~~'))
      return <Text key={key} style={{ textDecorationLine: 'line-through' }}>{part.slice(2, -2)}</Text>;
    if (part.startsWith('`') && part.endsWith('`'))
      return <Text key={key} style={{ fontFamily: 'monospace', color: colors.accent }}>{part.slice(1, -1)}</Text>;
    if (new RegExp(`^${DATE_TOKEN}$`, 'i').test(part)) return <Text key={key} style={{ color: colors.accent, fontWeight: '700' }}>{part}</Text>;
    return <Text key={key}>{part.replace(/\\([\\`*_{}\[\]()#+.!|-])/g, '$1')}</Text>;
  });
}

function cells(line: string) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(value => value.trim());
}

function isTableDivider(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

const LIST_LINE = /^(\s*)([-*+]\s+|\d+[.)]\s+)(.*)$/;

export function MarkdownContent({ value, colors }: { value: string; colors: Colors }) {
  const stylesFor = makeStyles(colors);
  const lines = clean(value.replace(/\r\n?/g, '\n')).split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i].trim();
    if (!raw || /^\s*([-*_]\s*){3,}$/.test(raw)) { i++; continue; }
    if (raw.includes('|') && lines[i + 1]?.includes('|') && isTableDivider(lines[i + 1])) {
      const headers = cells(raw);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      blocks.push(<View key={`table-${i}`} style={stylesFor.table}>
        {rows.map((row, rowIndex) => {
          const detail = row.slice(1).map((cell, columnIndex) => {
            const heading = headers[columnIndex + 1];
            return heading ? `${heading}: ${cell}` : cell;
          }).filter(Boolean).join(' · ');
          return <View key={rowIndex} style={stylesFor.tableRow}>
            <Text style={stylesFor.tableKey}>{inline(row[0] || headers[0] || '', colors, `tk-${rowIndex}`)}</Text>
            <Text style={stylesFor.tableValue}>{inline(detail || '—', colors, `tv-${rowIndex}`)}</Text>
          </View>;
        })}
      </View>);
      continue;
    }
    const heading = raw.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(<Text key={`h-${i}`} style={level === 1 ? stylesFor.h1 : level === 2 ? stylesFor.h2 : stylesFor.h3}>{inline(heading[2], colors, `h-${i}`)}</Text>);
      i++; continue;
    }
    if (raw.startsWith('>')) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>+\s?/, '').trim());
      blocks.push(<Text key={`quote-${i}`} style={stylesFor.quote}>{inline(quote.join(' '), colors, `quote-${i}`)}</Text>);
      continue;
    }
    if (/^```/.test(raw)) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(clean(lines[i++]));
      if (i < lines.length) i++;
      blocks.push(<Text key={`code-${i}`} style={stylesFor.code}>{code.join('\n')}</Text>);
      continue;
    }
    if (LIST_LINE.test(lines[i])) {
      const items: { depth: number; marker: string; text: string }[] = [];
      while (i < lines.length) {
        const match = lines[i].match(LIST_LINE);
        if (!match) break;
        const indent = match[1].replace(/\t/g, '  ').length;
        const depth = Math.min(3, Math.floor(indent / 2));
        const ordered = /^\d/.test(match[2]);
        items.push({ depth, marker: ordered ? `${match[2].match(/^\d+/)?.[0]}.` : '•', text: match[3] });
        i++;
      }
      blocks.push(<View key={`list-${i}`} style={stylesFor.list}>{items.map((item, itemIndex) => <View key={itemIndex} style={[stylesFor.listRow, { marginLeft: item.depth * 15 }]}>
        <Text style={stylesFor.marker}>{item.marker}</Text><Text style={stylesFor.listText}>{inline(item.text, colors, `li-${i}-${itemIndex}`)}</Text>
      </View>)}</View>);
      continue;
    }
    const paragraph = [raw]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)|^\s*(?:```|>)/.test(lines[i])) paragraph.push(lines[i++].trim());
    blocks.push(<Text key={`p-${i}`} style={stylesFor.paragraph}>{inline(paragraph.join(' '), colors, `p-${i}`)}</Text>);
  }
  return <View style={{ width: '100%' }}>{blocks}</View>;
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    h1: { color: c.text, fontSize: 19, lineHeight: 26, fontWeight: '800', marginTop: 11, marginBottom: 5 },
    h2: { color: c.text, fontSize: 16, lineHeight: 23, fontWeight: '700', marginTop: 10, marginBottom: 4 },
    h3: { color: c.text, fontSize: 14, lineHeight: 21, fontWeight: '700', marginTop: 8, marginBottom: 3 },
    paragraph: { color: c.text, fontSize: 14, lineHeight: 22, marginBottom: 9, flexShrink: 1 },
    quote: { color: c.muted, fontSize: 14, lineHeight: 22, marginVertical: 6, paddingLeft: 11, borderLeftWidth: 2, borderLeftColor: c.accent },
    list: { marginVertical: 3, marginBottom: 8 }, listRow: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 5 },
    marker: { width: 24, color: c.accent, fontSize: 14, lineHeight: 22, fontWeight: '700' },
    listText: { flex: 1, flexShrink: 1, color: c.text, fontSize: 14, lineHeight: 22 },
    table: { width: '100%', marginVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    tableRow: { width: '100%', flexDirection: 'row', gap: 10, paddingVertical: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: c.border },
    tableKey: { flex: 0.8, flexShrink: 1, color: c.muted, fontSize: 12, lineHeight: 18, fontWeight: '700' },
    tableValue: { flex: 1.2, flexShrink: 1, color: c.text, fontSize: 13, lineHeight: 19 },
    code: { color: c.text, backgroundColor: c.surface2, padding: 11, borderRadius: 10, fontFamily: 'monospace', fontSize: 12, lineHeight: 19, marginVertical: 6 },
  });
}
