'use strict';

const { nativeImage } = require('electron');

/** 圆角矩形命中判定 */
function inRoundRect(x, y, left, top, w, h, r) {
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  let dx = 0;
  let dy = 0;
  if (x < left + rx) dx = left + rx - x;
  else if (x > left + w - rx) dx = x - (left + w - rx);
  if (y < top + ry) dy = top + ry - y;
  else if (y > top + h - ry) dy = y - (top + h - ry);
  return dx * dx + dy * dy <= rx * ry;
}

/**
 * 画图标：金色圆角方块 + 三根深色递增柱（行情意象）。
 * nativeImage.createFromBitmap 要求 BGRA 顺序。
 */
function createIcon(size = 32) {
  const S = size * 4; // 4 倍超采样，缩小后边缘平滑
  const buf = Buffer.alloc(S * S * 4, 0);

  const gold = [224, 182, 104];
  const dark = [13, 16, 22];

  const pad = S * 0.05;
  const radius = S * 0.24;

  const barW = S * 0.105;
  const gap = S * 0.075;
  const bottom = S * 0.775;
  const heights = [0.24, 0.39, 0.54].map((h) => h * S);
  const startX = (S - (barW * 3 + gap * 2)) / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let color = null;
      if (inRoundRect(x, y, pad, pad, S - pad * 2, S - pad * 2, radius)) {
        color = gold;
        for (let i = 0; i < 3; i++) {
          const bx = startX + i * (barW + gap);
          const by = bottom - heights[i];
          if (inRoundRect(x, y, bx, by, barW, heights[i], barW * 0.3)) {
            color = dark;
            break;
          }
        }
      }
      if (!color) continue;
      const o = (y * S + x) * 4;
      buf[o] = color[2];
      buf[o + 1] = color[1];
      buf[o + 2] = color[0];
      buf[o + 3] = 255;
    }
  }

  const big = nativeImage.createFromBitmap(buf, { width: S, height: S });
  return big.resize({ width: size, height: size, quality: 'best' });
}

module.exports = { createIcon };