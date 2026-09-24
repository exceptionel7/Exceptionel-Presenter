import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { App } from './App.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('operator renderer: #root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
