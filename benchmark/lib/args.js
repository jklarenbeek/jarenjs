//#region benchmark CLI arguments
// The flag vocabulary shared verbatim by the engine-matrix runners
// (jsonquery, jslt, jsonpath). Runners with their own vocabularies
// (debug, callgraph, website-data) keep their own parsers.

/**
 * Parse the shared runner flags. A bare argument becomes the scenario
 * filter; an unknown `--flag` is first offered to `extra` so a runner
 * can add flags (jsonpath adds `--top`) without forking the parser.
 * @param {string[]} argv - `process.argv`
 * @param {object} config
 * @param {number} config.defaultIterations
 * @param {string[]} config.engines - Default engine keys
 * @param {object} [config.init] - Extra option defaults to seed
 * @param {(arg: string, next: () => string, options: object) => boolean} [config.extra]
 *   Handle a runner-specific flag; return true when consumed
 * @returns {object} The parsed options
 */
export function parseSuiteArgs(argv, { defaultIterations, engines, init = undefined, extra = undefined }) {
  const options = {
    profile: false,
    verbose: false,
    scale: false,
    iterations: defaultIterations,
    engines,
    output: 'console',
    filepath: null,
    ...init,
    filter: null,
    help: false,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--profile': options.profile = true; break;
      case '--verbose': case '-v': options.verbose = true; break;
      case '--scale': options.scale = true; break;
      case '--iterations': case '-i': {
        const value = argv[++i];
        const iterations = Number(value);
        if (!/^\d+$/.test(value ?? '') || !Number.isSafeInteger(iterations) || iterations < 1) {
          console.error('--iterations must be a positive integer');
          process.exit(2);
        }
        options.iterations = iterations;
        break;
      }
      case '--engines': options.engines = argv[++i].split(',').map((s) => s.trim()); break;
      case '--output': case '-o': options.output = argv[++i]; break;
      case '--filepath': case '-f': options.filepath = argv[++i]; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (extra !== undefined && extra(arg, () => argv[++i], options))
          break;
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(2);
        }
        options.filter = arg;
    }
  }
  return options;
}

//#endregion
