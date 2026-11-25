import type { KnipConfig } from 'knip';

// Knip discovers Node entry points in package scripts. Add the paths reached
// through docs, shell commands, browser bundles, and the Exact toolchain.
export default {
  includeEntryExports: true,
  workspaces: {
    '.': {
      entry: [
        '**/*.test.{ts,mts}',
        'adapters/exact/{generate,loading-web-test,run-web-test,serve,submission-web-test,test,web-test}.ts',
        'application/{browser,inspect-loading,inspect-submission}.ts',
        'inventory/app.ts',
        'leave/explained-{frames,video}.ts',
        'live/{app,worker}.ts',
        'proof/check.ts',
        'workbench/record-demo.ts',
        'workspace/app.ts',
      ],
      project: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
      // Exact's browser tests load Playwright from the pinned external checkout.
      ignoreDependencies: ['playwright-core'],
      // Video recording and inspection use system executables, not npm bins.
      ignoreBinaries: ['ffmpeg', 'ffprobe'],
    },
    'adapters/effect': {
      entry: ['index.ts', '*.test.ts', 'durable-worker.ts'],
      project: ['**/*.ts'],
    },
    'adapters/effect-ui': {
      entry: ['browser.ts', '*.test.ts'],
      project: ['**/*.ts'],
    },
  },
} satisfies KnipConfig;
