import { createElement } from 'react';

// Test-only stand-in for react-spinners (purely presentational).
export default function PulseLoader() {
    return createElement('span', { 'data-testid': 'spinner' });
}
