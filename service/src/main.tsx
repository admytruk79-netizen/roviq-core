import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './roviq-tokens.css';
import './service.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
