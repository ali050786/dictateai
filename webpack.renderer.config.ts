import type { Configuration } from 'webpack';

import { rules } from './webpack.rules';
import { plugins } from './webpack.plugins';

rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }],
});

// The start/stop sounds, inlined into the bundle as data: URLs. renderer.ts
// decodes them itself, so the Content-Security-Policy needs no change.
rules.push({
  test: /\.wav$/,
  type: 'asset/inline',
});

export const rendererConfig: Configuration = {
  // Forge's dev default (eval-source-map) needs 'unsafe-eval', which the
  // pages' Content-Security-Policy doesn't allow.
  devtool: 'source-map',
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
  },
};
