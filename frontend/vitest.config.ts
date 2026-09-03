import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/AccessibleDialog.tsx',
        'src/InstanceDetailTabs.tsx',
        'src/LaunchControls.tsx',
        'src/uiSemantics.ts',
      ],
      reporter: ['text'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
