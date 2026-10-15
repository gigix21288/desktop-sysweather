#!/usr/bin/env python3
"""Minimal .po -> .mo compiler (used when GNU gettext's msgfmt is missing).

Supports plural entries (msgid_plural / msgstr[N]) and multi-line strings;
comments, fuzzy flags and contexts (msgctxt) are not handled.
"""
import ast
import struct
import sys


def parse_po(path):
    messages = {}
    entry = None

    def flush():
        if not entry or entry['msgid'] is None:
            return
        if entry['plural'] is not None:
            forms = [entry['msgstr'][i] for i in sorted(entry['msgstr'])]
            if any(forms):
                messages[entry['msgid'] + '\0' + entry['plural']] = '\0'.join(forms)
        elif entry['msgstr'].get(0) or entry['msgid'] == '':
            messages[entry['msgid']] = entry['msgstr'].get(0, '')

    with open(path, encoding='utf-8') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            if line.startswith('msgid_plural '):
                entry['plural'] = ast.literal_eval(line[len('msgid_plural '):])
                target = ('plural',)
            elif line.startswith('msgid '):
                flush()
                entry = {'msgid': ast.literal_eval(line[6:]), 'plural': None, 'msgstr': {}}
                target = ('msgid',)
            elif line.startswith('msgstr['):
                index = int(line[7:line.index(']')])
                entry['msgstr'][index] = ast.literal_eval(line[line.index(']') + 1:].strip())
                target = ('msgstr', index)
            elif line.startswith('msgstr '):
                entry['msgstr'][0] = ast.literal_eval(line[7:])
                target = ('msgstr', 0)
            elif line.startswith('"'):
                text = ast.literal_eval(line)
                if target[0] == 'msgstr':
                    entry['msgstr'][target[1]] += text
                else:
                    entry[target[0]] += text
    flush()
    return messages


def write_mo(messages, path):
    keys = sorted(messages)
    ids = b''
    strs = b''
    offsets = []
    for k in keys:
        kb, vb = k.encode('utf-8'), messages[k].encode('utf-8')
        offsets.append((len(ids), len(kb), len(strs), len(vb)))
        ids += kb + b'\0'
        strs += vb + b'\0'
    n = len(keys)
    header_size = 7 * 4
    ids_start = header_size + n * 16
    strs_start = ids_start + len(ids)
    out = struct.pack('<7I', 0x950412de, 0, n, header_size, header_size + n * 8, 0, 0)
    out += b''.join(struct.pack('<2I', l, ids_start + o) for o, l, _, _ in offsets)
    out += b''.join(struct.pack('<2I', l, strs_start + o) for _, _, o, l in offsets)
    with open(path, 'wb') as f:
        f.write(out + ids + strs)


if __name__ == '__main__':
    write_mo(parse_po(sys.argv[1]), sys.argv[2])
