import { createRoot } from 'react-dom/client';
import '../styles.css';
import { OutputApp } from './OutputApp.tsx';

const container = document.getElementById('root');
if (!container) throw new Error('output renderer: #root is missing from index.html');

// Deliberately NOT StrictMode: its intentional double-rendering and double-invoked effects
// would open camera streams and restart video playback twice on the audience screen.
createRoot(container).render(<OutputApp />);
