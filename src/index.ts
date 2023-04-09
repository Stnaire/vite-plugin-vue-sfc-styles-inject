import fs from 'fs';
import { resolve } from 'path';
import type { Plugin, ResolvedConfig } from 'vite';

const utilityFunctions: string = `function injectStyles(id, css) {
    if (!css || typeof(document) === 'undefined' || document.getElementById(id)) {
        return;
    }
    var head = document.head || document.getElementsByTagName('head')[0];
    var style = document.createElement('style');
    style.id = id;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(css));
    head.appendChild(style);
}

const _export_sfc_with_styles = (sfc, props, styles) => {
    for (const prop of props) {
        if (prop[0] === 'render') {
            let injected = !styles;
            const render = prop[1];
            prop[1] = function () {
                if (!injected) {
                    injectStyles(styles[0], styles[1]);
                    injected = true;
                }
                return render.apply(this, arguments);
            };
            break;
        }
    }
    return _export_sfc(sfc, props);
};`;

function findInjectIndex(code: string): number {
    let idx = 0;
    let currentStrDelimiter = null;
    let escaped = false;
    let openParenthesis = 0;
    for (; idx < code.length; ++idx) {
        const c = code[idx];
        if (c === ')' && !currentStrDelimiter && !--openParenthesis) {
            return idx;
        }
        if (c === '(' && !currentStrDelimiter) {
            ++openParenthesis;
        } else if (c === currentStrDelimiter && !escaped) {
            currentStrDelimiter = null;
        } else if (
            !currentStrDelimiter &&
            (c === '"' || c === "'" || c === '`')
        ) {
            currentStrDelimiter = c;
        } else if (c === '\\' && currentStrDelimiter) {
            escaped = !escaped;
        } else {
            escaped = false;
        }
    }
    return -1;
}

const placeholderIdsCharacters: string = 'abcdefghijklmnopqrstuvwxyz0123456789';
const placeholdersIds: string[] = [];
function generatePlaceholderId() {
    const maxTries = 10;
    let tries = 0;
    let generatedId = '';
    do {
        if (tries++ >= maxTries) {
            throw 'Failed to generate a placeholder id.';
        }
        generatedId = '';
        for (let i = 0; i < 8; ++i) {
            generatedId += placeholderIdsCharacters.charAt(
                Math.floor(Math.random() * placeholderIdsCharacters.length)
            );
        }
    } while (placeholdersIds.indexOf(generatedId) > -1);
    placeholdersIds.push(generatedId);
    return generatedId;
}

let viteConfig!: ResolvedConfig;
const extractionMap: Record<string, {id: string, placeholder: string, css: string}> = {};

export default function SfcStylesInject(): Plugin {
    return {
        name: 'sfc-styles-inject',
        apply: 'build',

        configResolved(resolvedConfig) {
            viteConfig = resolvedConfig;
        },
        async transform(code, id) {
            const matches = id.match(/\/(\w+\.vue)/);
            if (matches) {
                const placeholderId = '_s-' + generatePlaceholderId();
                if (typeof extractionMap[matches[1]] === 'undefined') {
                    extractionMap[matches[1]] = {
                        id: placeholderId,
                        placeholder: '',
                        css: '',
                    };
                }
                if (/\.css$/.test(id)) {
                    extractionMap[matches[1]].css = code;
                    return { code: '' };
                } else {
                    const match = code.match(
                        /export\s+(default)?(\s+\/\*#__PURE__\*\/)?_export_sfc\(/
                    );
                    if (match && typeof match.index !== 'undefined') {
                        const injectIdx =
                            findInjectIndex(code.substring(match.index)) +
                            match.index;
                        if (injectIdx > 0) {
                            let i = injectIdx - 1;
                            for (; i >= 0 && code[i].match(/\s/); --i);
                            const requiresComa = i < 0 || code[i] !== ',';
                            extractionMap[
                                matches[1]
                            ].placeholder = `console.warn('__###${placeholderId}###__')`;
                            code =
                                code.substring(0, match.index) +
                                code
                                    .substring(match.index, injectIdx)
                                    .replace(
                                        '_export_sfc',
                                        '_export_sfc_with_styles'
                                    ) +
                                (requiresComa ? ',' : '') +
                                extractionMap[matches[1]].placeholder +
                                code.substring(injectIdx) +
                                `;_export_sfc({}, ['to-remove']);`; // So _export_sfc() is not removed from the build because it is unused.
                        }
                    }
                    return { code };
                }
            }
            if (viteConfig.build.lib && typeof(viteConfig.build.lib.entry) === 'string' && id.includes(viteConfig.build.lib.entry)) {
                return { code };
            }
            return null;
        },

        async writeBundle(_, bundle) {
            for (const file of Object.entries(bundle)) {
                const { root } = viteConfig;
                const outDir = viteConfig.build.outDir || 'dist';
                const fileName = file[0];
                const filePath = resolve(root, outDir, fileName);

                try {
                    let code = fs.readFileSync(filePath, {
                        encoding: 'utf8',
                    });

                    for (const component of Object.keys(extractionMap)) {
                        const placeholder =
                            extractionMap[component].placeholder;
                        const replacement = `['${extractionMap[component].id}', \`${extractionMap[component].css}\`]`;
                        code = code.replace(placeholder, replacement);
                        code = code.replace(
                            placeholder.replaceAll("'", '"'),
                            replacement
                        );
                    }
                    code = code.replaceAll(
                        `_export_sfc({}, ["to-remove"]);`,
                        ''
                    );
                    fs.writeFileSync(
                        filePath,
                        `${utilityFunctions}
    ${code}`
                    );
                } catch (e) {
                    console.error(e);
                }
            }
        },
    };
}
