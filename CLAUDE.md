# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A COOL language compiler written in Node.js/CommonJS using Jison (lex/yacc for JS). COOL source compiles
to [Bril](https://capra.cs.cornell.edu/bril/) JSON IR. There is no build step — everything runs directly
via `node`. There are no automated tests (`npm test` is a stub) and no lint config.

## Commands

Compile a `.cool` file (parse + semantic analysis only, writes `<file>.ast.json`):

```
node cool_jison.js path/to/file.cool
```

Compile a `.cool` file through the full pipeline (parse + semantic analysis + transpile to Bril, writes
`<file>.ast.json` and `<file>.bril.json`):

```
node cool_jison_with_transpiler.js path/to/file.cool
```

Sample inputs: `exemplo_basico.cool`, `exemplo_completo.cool`.

## Architecture

The pipeline is three sequential stages, each a separate module, wired together in the entry-point scripts
(`cool_jison.js` / `cool_jison_with_transpiler.js`). There is no shared driver — the grammar and pipeline
wiring live inline in those two files, which are near-duplicates of each other (the `_with_transpiler`
variant adds stage 3 and also annotates AST nodes with `line`/`col` from Jison's `@N` location markers).

1. **Lexer + parser (Jison grammar, inlined as a template string in `cool_jison*.js`)** — tokenizes and
   parses COOL source into a plain-JS-object AST. Grammar actions build nodes like
   `{ type: 'class', name, parent, features }`, `{ type: 'method', name, formals, returnType, body }`,
   `{ type: 'binop', op, left, right }`, etc. `cool_jison_with_transpiler.js` additionally stamps every
   node with `line`/`col` via the `loc()` helper for error reporting.

2. **Semantic analysis (`analise_semantica.js`, class `SemanticAnalyzer`)** — two passes over the AST:
   - `buildClassTable()`: registers built-in classes (`Object`, `IO`, `Int`, `Bool`, `String`) plus
     user classes, checks for duplicate/missing/cyclic inheritance, forbids inheriting from `Int`/`String`/
     `Bool`, and requires a `Main` class with a no-arg `main` method.
   - `checkClasses()` / `checkFeature()` / `checkExpr()`: recursive-descent type checking with a scope
     stack (`enterScope`/`exitScope`/`addVar`/`lookupVar`). Implements COOL's type rules: `conforms()`
     (subtyping), `join()` (least common ancestor, used by `if`/`case`), and `SELF_TYPE` resolution via
     `resolveSelfType()`. Every checked AST node gets annotated in place with `coolType`. Errors are
     collected (not thrown) as `"linha N, col M: message"` strings and returned from `analyze()`.

3. **Transpiler (`transpiler.js`, class `BrilTranspiler`)** — walks the type-annotated AST and emits Bril
   functions. Key conventions (see the file's header comment for the full mapping table):
   - Every COOL method becomes a Bril function named `ClassName.methodName`, with an implicit `self: int`
     first parameter — except `Main.main`, which becomes `main` with no `self` (Bril's entry point can't
     take a return type or self).
   - COOL `Int`/`Bool` map to Bril `int`/`bool`; everything else (`String`, class instances) is represented
     as a Bril `int` (a simulated tagged pointer / string-table index).
   - This stage is intentionally incomplete: `new T` just emits a placeholder constant (no heap), `case`
     dispatch always picks the first branch (no runtime type tags yet), and strings are not materialized.
     Check the header comment in `transpiler.js` before assuming a Bril feature is fully implemented.

Because semantic analysis mutates the AST (adding `coolType`, and `line`/`col` in the transpiler-aware
grammar), transpilation must always run *after* `analyzer.analyze()` on the same AST instance — see the
stage ordering in `cool_jison_with_transpiler.js`.

## Working in the grammar

The Jison grammar is a JS template literal, so editing it means editing string content inside
`cool_jison.js`/`cool_jison_with_transpiler.js` — there's no separate `.jison` file. Grammar/AST changes
made in one file are not automatically reflected in the other; keep them in sync manually if the change is
structural (new expression types need matching `case`s added in both `analise_semantica.js` and
`transpiler.js`).
