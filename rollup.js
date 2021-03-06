let rollup = require('rollup');
let commonjs = require('rollup-plugin-commonjs');
let nodeResolve = require('rollup-plugin-node-resolve');
let includepaths = require('rollup-plugin-includepaths');
let filesize = require('rollup-plugin-filesize');
let progress = require('rollup-plugin-progress');
let {uglify} = require('rollup-plugin-uglify');
let buble = require('rollup-plugin-buble');
let json = require('rollup-plugin-json');
let string = require('rollup-plugin-string');

let uglifyOptions = {
    mangle: true,
    compress: {
        warnings: false, // Suppress uglification warnings
        pure_getters: true,
        unsafe: true
    },
    output: {
        comments: false
    }
};

let inputOptions = {
    input: './lib/index.js',
    plugins: [
        progress({ clearLine: false }),
        includepaths({ paths: ['./lib', './dist', './node_modules'] }),
        nodeResolve({
            jsnext: true,
            main: true,
            browser: true
        }),
        string({
            include: '**/*.svg'
        }),
        commonjs({
            include: [
                './node_modules/**'
            ], // Default: undefined
            // if false then skip sourceMap generation for CommonJS modules
            sourceMap: true // Default: true

        }),
        json(),
        buble()
    ],
    cache: null
};

let outputOptions = {
    file: './dist/iludb.min.js',
    format: 'umd',
    sourcemap: true,
    name: 'IluDB'
};

if (process.env.NODE_ENV === 'production') {
    outputOptions.sourcemap = false;
    inputOptions.plugins.push(uglify(uglifyOptions));
    inputOptions.plugins.push(filesize());
    rollup.rollup(inputOptions)
        .then(bundle => bundle.write(outputOptions))
        .then(() => console.log('Bundle finished.'));
}

if (process.env.NODE_ENV !== 'production') {
    inputOptions.plugins.push(filesize());

    inputOptions.output = outputOptions;
    inputOptions.watch = {
        include: ['./lib/**'],
        chokidar: false
    };

    const watch = rollup.watch(inputOptions);
    const stderr = console.error.bind(console);

    watch.on('event', (event) => {
        switch (event.code) {
            case 'START':
                stderr('checking rollup-watch version...');
                break;
            case 'BUNDLE_START':
                stderr(`bundling ${outputOptions.file}...`);
                break;
            case 'BUNDLE_END':
                stderr(`${outputOptions.file} bundled in ${event.duration}ms.`);
                break;
            case 'ERROR':
                stderr(`error: ${event.error}`);
                break;
            case 'FATAL':
                stderr(`error: ${event.error}`);
                break;
            case 'END':
                stderr(`Watching for changes...`);
                break;
            default:
                stderr(`unknown event: ${event}`);
        }
    });
}
