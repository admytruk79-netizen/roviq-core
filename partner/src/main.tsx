import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import './universal.css';

// The standalone ROVIQ Shop OS app is this workspace built with VITE_PRODUCT=shop.
if (import.meta.env.VITE_PRODUCT === 'shop') document.title = 'ROVIQ Shop OS';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
