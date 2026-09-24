import { createRoot } from 'react-dom/client';
import '../styles.css';
import { ConfidenceApp } from './ConfidenceApp.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('confidence renderer: #root is missing from index.html');

createRoot(container).render(<ConfidenceApp />);
