import { readFileSync } from 'node:fs';

// Часы меняются только в тестовом процессе через --import, без HTTP-управления временем.
Date.now = () => Number(readFileSync('clock', 'utf8'));
