#!/usr/bin/env python3
"""A minimal QR encoder: byte mode, error correction level M, versions 1-9.

Enough to turn a LAN URL into something a phone camera can read, with no dependencies.
Follows ISO/IEC 18004; the module placement follows the same conventions as Nayuki's
reference implementation (x is the column, y is the row).
"""
from __future__ import annotations

# version: (error-correction codewords per block, [(block count, data codewords per block), ...])
ECC_M = {1: (10, [(1, 16)]), 2: (16, [(1, 28)]), 3: (26, [(1, 44)]), 4: (18, [(2, 32)]),
         5: (24, [(2, 43)]), 6: (16, [(4, 27)]), 7: (18, [(4, 31)]),
         8: (22, [(2, 38), (2, 39)]), 9: (22, [(3, 36), (2, 37)])}
ALIGN = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
         7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46]}
REMAINDER = {1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0}
PAD = (0xEC, 0x11)

# ------------------------------------------------------------------ GF(256)
EXP = [0] * 512
LOG = [0] * 256
_x = 1
for _i in range(255):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 0x100: _x ^= 0x11D
for _i in range(255, 512): EXP[_i] = EXP[_i - 255]

def _mul(a, b):
    return 0 if a == 0 or b == 0 else EXP[LOG[a] + LOG[b]]

def _generator(count):
    poly = [1]
    for i in range(count):
        nxt = [0] * (len(poly) + 1)
        for j, c in enumerate(poly):
            nxt[j] ^= _mul(c, 1)
            nxt[j + 1] ^= _mul(c, EXP[i])
        poly = nxt
    return poly

def _remainder(data, count):
    """Reed-Solomon error correction codewords for one block."""
    gen = _generator(count)
    work = list(data) + [0] * count
    for i in range(len(data)):
        lead = work[i]
        if not lead: continue
        for j, g in enumerate(gen):
            work[i + j] ^= _mul(g, lead)
    return work[len(data):]

# --------------------------------------------------------------- bit stream
def _codewords(payload, version):
    ec_count, groups = ECC_M[version]
    capacity = sum(n * size for n, size in groups)
    bits = []
    def put(value, width):
        for shift in range(width - 1, -1, -1): bits.append((value >> shift) & 1)
    put(0b0100, 4)          # byte mode
    put(len(payload), 8)    # versions 1-9 use an 8-bit character count
    for byte in payload: put(byte, 8)
    put(0, min(4, capacity * 8 - len(bits)))
    while len(bits) % 8: bits.append(0)
    data = [int(''.join(map(str, bits[i:i + 8])), 2) for i in range(0, len(bits), 8)]
    while len(data) < capacity: data.append(PAD[len(data) % 2])

    blocks, checks, at = [], [], 0
    for count, size in groups:
        for _ in range(count):
            block = data[at:at + size]
            at += size
            blocks.append(block)
            checks.append(_remainder(block, ec_count))

    out = []
    for i in range(max(len(b) for b in blocks)):
        out += [b[i] for b in blocks if i < len(b)]
    for i in range(ec_count):
        out += [c[i] for c in checks]
    return out

def _version_for(payload):
    for version in sorted(ECC_M):
        capacity = sum(n * size for n, size in ECC_M[version][1])
        if 4 + 8 + len(payload) * 8 <= capacity * 8: return version
    raise ValueError("text too long for a version 1-9 QR code")

# ------------------------------------------------------------------ BCH bits
def _bch(value, generator, width):
    rest = value << width
    while rest.bit_length() > width:
        rest ^= generator << (rest.bit_length() - generator.bit_length())
    return rest

def _format_bits(mask):
    data = (0b00 << 3) | mask                      # 0b00 selects level M
    return ((data << 10) | _bch(data, 0x537, 10)) ^ 0x5412

def _version_bits(version):
    return (version << 12) | _bch(version, 0x1F25, 12)

# -------------------------------------------------------------------- matrix
class _Grid:
    def __init__(self, version):
        self.version = version
        self.size = version * 4 + 17
        self.modules = [[False] * self.size for _ in range(self.size)]
        self.fixed = [[False] * self.size for _ in range(self.size)]

    def set(self, x, y, dark):
        self.modules[y][x] = dark
        self.fixed[y][x] = True

    def finder(self, x, y):
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                cx, cy = x + dx, y + dy
                if 0 <= cx < self.size and 0 <= cy < self.size:
                    reach = max(abs(dx), abs(dy))
                    self.set(cx, cy, reach != 2 and reach != 4)

    def patterns(self):
        for i in range(self.size):
            self.set(6, i, i % 2 == 0)
            self.set(i, 6, i % 2 == 0)
        self.finder(3, 3)
        self.finder(self.size - 4, 3)
        self.finder(3, self.size - 4)
        centres = ALIGN[self.version]
        for i, cy in enumerate(centres):
            for j, cx in enumerate(centres):
                corner = (i, j) in ((0, 0), (0, len(centres) - 1), (len(centres) - 1, 0))
                if corner: continue
                for dy in range(-2, 3):
                    for dx in range(-2, 3):
                        self.set(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)
        self.reserve()

    def reserve(self):
        for i in range(9):
            self.set(8, i, False)
            self.set(i, 8, False)
        for i in range(8):
            self.set(8, self.size - 1 - i, False)
            self.set(self.size - 1 - i, 8, False)
        if self.version >= 7:
            for i in range(18):
                self.set(self.size - 11 + i % 3, i // 3, False)
                self.set(i // 3, self.size - 11 + i % 3, False)

    def draw_format(self, mask):
        bits = _format_bits(mask)
        get = lambda i: (bits >> i) & 1 == 1
        for i in range(6): self.set(8, i, get(i))
        self.set(8, 7, get(6))
        self.set(8, 8, get(7))
        self.set(7, 8, get(8))
        for i in range(9, 15): self.set(14 - i, 8, get(i))
        for i in range(8): self.set(self.size - 1 - i, 8, get(i))
        for i in range(8, 15): self.set(8, self.size - 15 + i, get(i))
        self.set(8, self.size - 8, True)                 # the always-dark module

    def draw_version(self):
        if self.version < 7: return
        bits = _version_bits(self.version)
        for i in range(18):
            dark = (bits >> i) & 1 == 1
            self.set(self.size - 11 + i % 3, i // 3, dark)
            self.set(i // 3, self.size - 11 + i % 3, dark)

    def draw_data(self, codewords):
        stream = [(byte >> shift) & 1 for byte in codewords for shift in range(7, -1, -1)]
        stream += [0] * REMAINDER[self.version]
        at = 0
        for right in range(self.size - 1, 0, -2):
            if right == 6: right = 5
            for step in range(self.size):
                for j in range(2):
                    x = right - j
                    upward = ((right + 1) & 2) == 0
                    y = (self.size - 1 - step) if upward else step
                    if not self.fixed[y][x] and at < len(stream):
                        self.modules[y][x] = stream[at] == 1
                        at += 1

    def masked(self, mask):
        rule = (lambda x, y: (x + y) % 2 == 0,
                lambda x, y: y % 2 == 0,
                lambda x, y: x % 3 == 0,
                lambda x, y: (x + y) % 3 == 0,
                lambda x, y: (x // 3 + y // 2) % 2 == 0,
                lambda x, y: x * y % 2 + x * y % 3 == 0,
                lambda x, y: (x * y % 2 + x * y % 3) % 2 == 0,
                lambda x, y: ((x + y) % 2 + x * y % 3) % 2 == 0)[mask]
        for y in range(self.size):
            for x in range(self.size):
                if not self.fixed[y][x] and rule(x, y):
                    self.modules[y][x] = not self.modules[y][x]

    def penalty(self):
        size, mods, score = self.size, self.modules, 0
        for line in [mods[y] for y in range(size)] + [[mods[y][x] for y in range(size)] for x in range(size)]:
            run, colour = 1, line[0]
            history = []
            for value in line[1:]:
                if value == colour: run += 1
                else:
                    if run >= 5: score += 3 + run - 5
                    history.append(run)
                    run, colour = 1, value
            if run >= 5: score += 3 + run - 5
            text = ''.join('1' if v else '0' for v in line)
            score += 40 * (text.count('10111010000') + text.count('00001011101'))
        for y in range(size - 1):
            for x in range(size - 1):
                block = (mods[y][x], mods[y][x + 1], mods[y + 1][x], mods[y + 1][x + 1])
                if all(block) or not any(block): score += 3
        dark = sum(row.count(True) for row in mods)
        score += 10 * (abs(dark * 100 // (size * size) - 50) // 5)
        return score

def matrix(text):
    """The QR modules for `text` as a list of rows of booleans."""
    payload = text.encode()
    version = _version_for(payload)
    codewords = _codewords(payload, version)
    best = None
    for mask in range(8):
        grid = _Grid(version)
        grid.patterns()
        grid.draw_version()
        grid.draw_data(codewords)
        grid.masked(mask)
        grid.draw_format(mask)
        score = grid.penalty()
        if best is None or score < best[0]: best = (score, grid)
    return best[1].modules

def svg(text, scale=6, quiet=4):
    """A self-contained SVG QR code — no external references, safe to inline."""
    mods = matrix(text)
    size = len(mods) + quiet * 2
    span = size * scale
    runs = []
    for y, row in enumerate(mods):
        x = 0
        while x < len(row):
            if row[x]:
                start = x
                while x < len(row) and row[x]: x += 1
                runs.append(f'M{(start + quiet) * scale} {(y + quiet) * scale}'
                            f'h{(x - start) * scale}v{scale}h-{(x - start) * scale}z')
            else:
                x += 1
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {span} {span}" '
            f'width="{span}" height="{span}" shape-rendering="crispEdges" role="img" '
            f'aria-label="QR code for {text}">'
            f'<rect width="{span}" height="{span}" fill="#fff"/>'
            f'<path fill="#000" d="{"".join(runs)}"/></svg>')

def text_art(text):
    """The same code as terminal output, two rows per line of half-blocks."""
    mods = matrix(text)
    pad = [[False] * (len(mods) + 8)] * 4
    rows = pad + [[False] * 4 + row + [False] * 4 for row in mods] + pad
    lines = []
    for y in range(0, len(rows), 2):
        top, bottom = rows[y], rows[y + 1] if y + 1 < len(rows) else [False] * len(rows[0])
        lines.append(''.join('█' if t and b else '▀' if t else '▄' if b else ' '
                             for t, b in zip(top, bottom)))
    return '\n'.join(lines)

if __name__ == "__main__":
    import sys
    print(text_art(sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787/"))
