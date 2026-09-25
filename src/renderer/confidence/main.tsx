import '../styles.css';
import { bootstrap } from '@ui/bootstrap.tsx';
import { ConfidenceApp } from './ConfidenceApp.tsx';

// The confidence monitor faces the stage, so an error here is worth showing — the pastor
// seeing "interface error" is better than staring at a blank screen mid-sermon.
bootstrap(<ConfidenceApp />, { role: 'confidence' });
