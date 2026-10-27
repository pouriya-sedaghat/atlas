import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import regularUrl from 'vazirmatn/fonts/webfonts/Vazirmatn-Regular.woff2?url';
import boldUrl from 'vazirmatn/fonts/webfonts/Vazirmatn-Bold.woff2?url';
import { App } from './App';
import './styles.css';

// UI font served from this origin (bundled from the pinned vazirmatn package).
for (const [url, weight] of [
  [regularUrl, '400'],
  [boldUrl, '700'],
] as const) {
  const face = new FontFace('Vazirmatn', `url(${url}) format('woff2')`, { weight, display: 'swap' });
  document.fonts.add(face);
  void face.load().catch(() => undefined);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
