// docs/assets/display.js — canvas display surface for the webix demo.
// Two render modes share one <canvas>:
//   1. ANSI tty — renders character cells with SGR colors / cursor reset.
//   2. FB pixel protocol — `FB <w> <h>\n<base64 rgba>\n` blocks decoded to ImageData.
// No real X server, no mmap framebuffer in the POSIX NOJIT NOSOCK build —
// the protocol parser is the honest substrate. Guest ELFs that emit FB lines
// are a named residual (argv space-join + no pipes makes it impractical from busybox).

const FB_RE = /^FB (\d+) (\d+)\n([A-Za-z0-9+/=\n]+?)(?=\nFB |\n*$)/m;

const ANSI_PALETTE = {
  30:'#1F1B16',31:'#c2410c',32:'#16a34a',33:'#a16207',34:'#1d4ed8',
  35:'#a21caf',36:'#0e7490',37:'#1F1B16',39:'#1F1B16',
  90:'#6b7280',91:'#dc2626',92:'#22c55e',93:'#ca8a04',94:'#3b82f6',
  95:'#c026d3',96:'#0891b2',97:'#1F1B16'
};

function parseAnsi(text){
  const out = [];
  let i = 0; let color = '#1F1B16'; let bold = false;
  while (i < text.length){
    if (text[i] === '\x1b' && text[i+1] === '['){
      const m = /\x1b\[([\d;]*)m/y; m.lastIndex = i;
      const match = m.exec(text);
      if (match){
        const codes = match[1].split(';').filter(Boolean).map(Number);
        for (const c of codes){
          if (c === 0){ color = '#1F1B16'; bold = false }
          else if (c === 1) bold = true;
          else if (ANSI_PALETTE[c]) color = ANSI_PALETTE[c];
        }
        i = m.lastIndex;
        continue;
      }
    }
    out.push({ ch: text[i], color, bold });
    i++;
  }
  return out;
}

export function createDisplay(canvas){
  const ctx = canvas.getContext('2d');
  const cellW = 8, cellH = 16;
  const cols = Math.floor(canvas.width / cellW);
  const rows = Math.floor(canvas.height / cellH);

  function clear(){
    ctx.fillStyle = '#FBF6EB';
    ctx.fillRect(0,0,canvas.width,canvas.height);
  }

  function renderAnsi(text){
    clear();
    ctx.font = `13px 'JetBrains Mono', ui-monospace, monospace`;
    ctx.textBaseline = 'top';
    const cells = parseAnsi(text);
    let col = 0, row = 0;
    for (const { ch, color, bold } of cells){
      if (ch === '\n'){ row++; col = 0; continue }
      if (ch === '\r'){ col = 0; continue }
      if (row >= rows) break;
      if (col >= cols){ row++; col = 0; if (row >= rows) break }
      ctx.fillStyle = color;
      ctx.font = `${bold ? '700 ' : ''}13px 'JetBrains Mono', ui-monospace, monospace`;
      ctx.fillText(ch, col * cellW + 4, row * cellH + 2);
      col++;
    }
  }

  function renderFb(w, h, rgbaBytes){
    const targetW = Math.min(canvas.width, w * 4);
    const targetH = Math.min(canvas.height, h * 4);
    const scale = Math.min(targetW / w, targetH / h);
    clear();
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(w, h);
    img.data.set(rgbaBytes.subarray(0, w*h*4));
    offCtx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    const dx = (canvas.width - w*scale)/2;
    const dy = (canvas.height - h*scale)/2;
    ctx.drawImage(off, dx, dy, w*scale, h*scale);
  }

  function tryParseFb(text){
    const m = text.match(FB_RE);
    if (!m) return false;
    const w = parseInt(m[1],10), h = parseInt(m[2],10);
    const b64 = m[3].replace(/\s+/g,'');
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i);
    if (u8.length < w*h*4) return false;
    renderFb(w, h, u8);
    return true;
  }

  function render(text){
    if (!tryParseFb(text)) renderAnsi(text);
  }

  // synthesize an FB demo frame so the pixel path is reachable from the page
  // even though no current ELF emits the protocol. 64x64 hue gradient.
  function paintDemo(){
    const w = 64, h = 64;
    const buf = new Uint8Array(w*h*4);
    for (let y=0;y<h;y++){
      for (let x=0;x<w;x++){
        const i = (y*w + x) * 4;
        buf[i  ] = (x * 4) & 255;
        buf[i+1] = (y * 4) & 255;
        buf[i+2] = ((x+y) * 2) & 255;
        buf[i+3] = 255;
      }
    }
    // build the protocol text the parser would receive from a guest
    let b64 = '';
    const chunk = 0x8000;
    for (let p=0;p<buf.length;p+=chunk){
      b64 += String.fromCharCode.apply(null, buf.subarray(p, p+chunk));
    }
    const text = `FB ${w} ${h}\n${btoa(b64)}\n`;
    render(text);
    return text;
  }

  function pixelAt(x, y){
    const d = ctx.getImageData(x, y, 1, 1).data;
    return { r:d[0], g:d[1], b:d[2], a:d[3] };
  }

  clear();
  return { render, renderAnsi, renderFb, paintDemo, pixelAt, clear };
}
