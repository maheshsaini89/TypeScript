/// <reference types="node"/>

import * as ts from "../lib/typescript";
import * as path from "path";

function endsWith(s: string, suffix: string) {
    return s.lastIndexOf(suffix, s.length - suffix.length) !== -1;
}

class DeclarationsWalker {
    private visitedTypes: ts.Type[] = [];
    private text = "";
    private constructor(private typeChecker: ts.TypeChecker, private protocolFile: ts.SourceFile) {
    }

    static getExtraDeclarations(typeChecker: ts.TypeChecker, protocolFile: ts.SourceFile): string {
        let text = "declare namespace ts.server.protocol {\n";
        var walker = new DeclarationsWalker(typeChecker, protocolFile);
        walker.visitTypeNodes(protocolFile);
        return walker.text 
            ? `declare namespace ts.server.protocol {\n${walker.text}}`
            : "";
    }

    private processType(type: ts.Type): void {
        if (this.visitedTypes.indexOf(type) >= 0) {
            return;
        }
        this.visitedTypes.push(type);
        let s = type.aliasSymbol || type.getSymbol();
        if (!s) {
            return;
        }
        if (s.name === "Array") {
            // we should process type argument instead
            return this.processType((<any>type).typeArguments[0]);
        }
        else {
            for (const decl of s.getDeclarations()) {
                const sourceFile = decl.getSourceFile();
                if (sourceFile === this.protocolFile || path.basename(sourceFile.fileName) === "lib.d.ts") {
                    return;
                }
                // splice declaration in final d.ts file
                const text = decl.getFullText();
                this.text += `${text}\n`;

                // recursively pull all dependencies into result dts file
                this.visitTypeNodes(decl);
            }
        }
    }

    private visitTypeNodes(node: ts.Node) {
        if (node.parent) {
            switch (node.parent.kind) {
                case ts.SyntaxKind.VariableDeclaration:
                case ts.SyntaxKind.MethodDeclaration:
                case ts.SyntaxKind.MethodSignature:
                case ts.SyntaxKind.PropertyDeclaration:
                case ts.SyntaxKind.PropertySignature:
                case ts.SyntaxKind.Parameter:
                case ts.SyntaxKind.IndexSignature:
                    if (((<ts.VariableDeclaration | ts.MethodDeclaration | ts.PropertyDeclaration | ts.ParameterDeclaration | ts.PropertySignature | ts.MethodSignature | ts.IndexSignatureDeclaration>node.parent).type) === node) {
                        const type = this.typeChecker.getTypeAtLocation(node);
                        if (type && !(type.flags & ts.TypeFlags.TypeParameter)) {
                            this.processType(type);
                        }
                    }
                    break;
            }
        }
        ts.forEachChild(node, n => this.visitTypeNodes(n));
    } 
}

function generateProtocolFile(protocolTs: string, typeScriptServicesDts: string): string {
    const options = { target: ts.ScriptTarget.ES5, declaration: true, noResolve: true, types: <string[]>[], stripInternal: true };

    /**
     * 1st pass - generate a program from protocol.ts and typescriptservices.d.ts and emit core version of protocol.d.ts with all internal members stripped
     * @return text of protocol.d.t.s
     */
    function getInitialDtsFileForProtocol() {
        const program = ts.createProgram([protocolTs, typeScriptServicesDts], options);

        let protocolDts: string;
        program.emit(program.getSourceFile(protocolTs), (file, content) => {
            if (endsWith(file, ".d.ts")) {
                protocolDts = content;
            }
        });
        if (protocolDts === undefined) {
            throw new Error(`Declaration file for protocol.ts is not generated`)
        }
        return protocolDts;
    }

    const protocolFileName = "protocol.d.ts";
    /**
     * Second pass - generate a program from protocol.d.ts and typescriptservices.d.ts, then augment core protocol.d.ts with extra types from typescriptservices.d.ts
     */
    function getProgramWithProtocolText(protocolDts: string, includeTypeScriptServices: boolean) {
        const host = ts.createCompilerHost(options);
        const originalGetSourceFile = host.getSourceFile;
        host.getSourceFile = (fileName) => {
            if (fileName === protocolFileName) {
                return ts.createSourceFile(fileName, protocolDts, options.target);
            }
            return originalGetSourceFile.apply(host, [fileName]);
        }
        const rootFiles = includeTypeScriptServices ? [protocolFileName, typeScriptServicesDts] : [protocolFileName];
        return ts.createProgram(rootFiles, options, host);
    }

    let protocolDts = getInitialDtsFileForProtocol();
    const program = getProgramWithProtocolText(protocolDts, /*includeTypeScriptServices*/ true);

    const protocolFile = program.getSourceFile("protocol.d.ts");
    const extraDeclarations = DeclarationsWalker.getExtraDeclarations(program.getTypeChecker(), protocolFile);
    if (extraDeclarations) {
        protocolDts += extraDeclarations;
    }
    // do sanity check and try to compile generated text as standalone program
    const sanityCheckProgram = getProgramWithProtocolText(protocolDts, /*includeTypeScriptServices*/ false);
    const diagnostics = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics(), ...program.getGlobalDiagnostics()];
    if (diagnostics.length) {
        const flattenedDiagnostics = diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
        throw new Error(`Unexpected errors during sanity check: ${flattenedDiagnostics}`);
    }
    return protocolDts;
}

if (process.argv.length < 5) {
    console.log(`Expected 3 arguments: path to 'protocol.ts', path to 'typescriptservices.d.ts' and path to output file`);
    process.exit(1);
}

const protocolTs = process.argv[2];
const typeScriptServicesDts = process.argv[3];
const outputFile = process.argv[4];
const generatedProtocolDts = generateProtocolFile(protocolTs, typeScriptServicesDts);
ts.sys.writeFile(outputFile, generatedProtocolDts);
