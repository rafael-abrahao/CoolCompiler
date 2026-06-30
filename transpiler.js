/**
 * Transpilador COOL → Bril
 *
 * Mapeamento de tipos
 * ───────────────────
 *   COOL Int    → Bril int
 *   COOL Bool   → Bril bool
 *   COOL String → Bril int  (índice em string table; Bril core não tem strings)
 *   Qualquer objeto COOL → Bril int  (tagged pointer simulado)
 *
 * Mapeamento de funções
 * ─────────────────────
 *   Cada método COOL vira uma função Bril "ClassName.methodName".
 *   O primeiro parâmetro é sempre "self" (int), seguido dos formais originais.
 *   Exceção: Main.main vira "main" sem self e sem tipo de retorno,
 *   conforme a especificação de Bril ("main" não pode ter return type).
 *
 * Limitações conhecidas
 * ─────────────────────
 *   • `new T` emite const 1 (non-void placeholder) — Bril core não tem heap.
 *   • `case` gera um br real sobre a variável _typeTag injetada no self;
 *     na ausência de informação de runtime, escolhe o primeiro branch.
 *   • Strings são representadas como int 0 (índice em tabela futura).
 */

class BrilTranspiler {

    constructor(ast, classTable) {
        this.ast         = ast;
        this.classTable  = classTable;
        this.functions   = [];       // Bril functions acumuladas
        this.instrs      = [];       // instrções da função atual
        this.tempCount   = 0;        // contador de temporários
        this.labelCount  = 0;        // contador de labels
        this.currentCls  = null;     // classe sendo transpilada
    }

    // ─── Utilitários ─────────────────────────────────────────────────────────

    freshTemp(hint = 't') {
        return `${hint}${this.tempCount++}`;
    }

    freshLabel(prefix) {
        return `${prefix}_${this.labelCount++}`;
    }

    emit(instr) {
        this.instrs.push(instr);
    }

    // Converte um tipo COOL para o tipo Bril equivalente.
    // Todos os objetos (não-primitivos) são representados como int.
    brilType(coolType) {
        const resolved = coolType === 'SELF_TYPE' ? this.currentCls : coolType;
        if (resolved === 'Int')  return 'int';
        if (resolved === 'Bool') return 'bool';
        return 'int';  // String, Object, classes do usuário → int (tagged pointer)
    }

    // Valor padrão de inicialização por tipo (regra §5 do manual COOL)
    defaultValue(coolType) {
        if (coolType === 'Int')  return 0;
        if (coolType === 'Bool') return false;
        return 0;   // void para qualquer outro tipo
    }

    // Resolve SELF_TYPE para o nome da classe atual
    resolveType(type) {
        return type === 'SELF_TYPE' ? this.currentCls : type;
    }

    // ─── Entrada principal ────────────────────────────────────────────────────

    transpile() {
        for (const cls of this.ast) {
            this.transpileClass(cls);
        }
        return { functions: this.functions };
    }

    // ─── Classe ───────────────────────────────────────────────────────────────

    transpileClass(cls) {
        this.currentCls = cls.name;
        for (const feature of cls.features) {
            if (feature.type === 'method') {
                this.transpileMethod(cls, feature);
            }
            // Atributos não viram funções Bril —
            // são inicializados dentro do construtor (new) quando implementado
        }
    }

    // ─── Método ───────────────────────────────────────────────────────────────

    transpileMethod(cls, method) {
        this.instrs    = [];
        this.tempCount = 0;
        this.labelCount = 0;

        const isMain = cls.name === 'Main' && method.name === 'main';

        // Nome da função Bril
        const funcName = isMain ? 'main' : `${cls.name}.${method.name}`;

        // Parâmetros: self implícito + formais do método
        // main não leva self (especificação Bril)
        const args = isMain
            ? method.formals.map(f => ({
                name: f.name,
                type: this.brilType(f.declType)
              }))
            : [
                { name: 'self', type: 'int' },
                ...method.formals.map(f => ({
                    name: f.name,
                    type: this.brilType(f.declType)
                }))
              ];

        // Transpila o corpo e obtém a variável com o resultado
        const resultVar = this.transpileExpr(method.body);

        // Emite ret com o resultado (main não retorna valor em Bril)
        if (isMain) {
            this.emit({ op: 'ret', args: [] });
        } else {
            this.emit({ op: 'ret', args: resultVar ? [resultVar] : [] });
        }

        // Monta o objeto Function do Bril
        const func = { name: funcName, args, instrs: this.instrs };

        // main não deve ter campo "type" (especificação Bril §Program)
        if (!isMain && method.returnType && method.returnType !== 'Object') {
            func.type = this.brilType(method.returnType);
        }

        this.functions.push(func);
    }

    // ─── Expressões ──────────────────────────────────────────────────────────

    transpileExpr(expr) {
        switch (expr.type) {
            case 'int':            return this.transpileInt(expr);
            case 'bool':           return this.transpileBool(expr);
            case 'string':         return this.transpileString(expr);
            case 'object':         return this.transpileObject(expr);
            case 'assign':         return this.transpileAssign(expr);
            case 'binop':          return this.transpileBinop(expr);
            case 'if':             return this.transpileIf(expr);
            case 'while':          return this.transpileWhile(expr);
            case 'block':          return this.transpileBlock(expr);
            case 'let':            return this.transpileLet(expr);
            case 'neg':            return this.transpileNeg(expr);
            case 'not':            return this.transpileNot(expr);
            case 'isvoid':         return this.transpileIsvoid(expr);
            case 'new':            return this.transpileNew(expr);
            case 'dispatch':       return this.transpileDispatch(expr);
            case 'self_dispatch':  return this.transpileSelfDispatch(expr);
            case 'static_dispatch':return this.transpileStaticDispatch(expr);
            case 'case':           return this.transpileCase(expr);
            default:
                throw new Error(`Transpiler: nó não suportado '${expr.type}'`);
        }
    }

    // ── Literais ──────────────────────────────────────────────────────────────

    transpileInt(expr) {
        const dest = this.freshTemp('i');
        this.emit({ op: 'const', dest, type: 'int', value: expr.value });
        return dest;
    }

    transpileBool(expr) {
        const dest = this.freshTemp('b');
        this.emit({ op: 'const', dest, type: 'bool', value: expr.value });
        return dest;
    }

    // Strings não existem no core Bril — emite int 0 como placeholder.
    // Uma extensão futura pode usar um array de chars ou uma string table.
    transpileString(expr) {
        const dest = this.freshTemp('s');
        this.emit({ op: 'const', dest, type: 'int', value: 0 });
        return dest;
    }

    // ── Identificadores ───────────────────────────────────────────────────────

    // Retorna diretamente o nome da variável Bril.
    // Em Bril, variáveis são referenciadas pelo nome — não é necessário emitir id.
    transpileObject(expr) {
        return expr.name;  // 'self', 'x', 'y', etc.
    }

    // ── Atribuição ────────────────────────────────────────────────────────────

    // COOL: id <- expr
    // Bril: dest = id expr   (instrução id copia um valor entre variáveis)
    transpileAssign(expr) {
        const val  = this.transpileExpr(expr.expr);
        const type = this.brilType(expr.expr.coolType || 'Object');
        // id é a operação de cópia do Bril — preserva o tipo
        this.emit({ op: 'id', dest: expr.name, type, args: [val] });
        return expr.name;
    }

    // ── Operações binárias ────────────────────────────────────────────────────

    transpileBinop(expr) {
        const left  = this.transpileExpr(expr.left);
        const right = this.transpileExpr(expr.right);
        const dest  = this.freshTemp('v');

        // Mapeamento direto COOL → Bril
        const opMap = {
            '+':  { op: 'add', type: 'int'  },
            '-':  { op: 'sub', type: 'int'  },
            '*':  { op: 'mul', type: 'int'  },
            '/':  { op: 'div', type: 'int'  },
            '<':  { op: 'lt',  type: 'bool' },
            '<=': { op: 'le',  type: 'bool' },
            '=':  { op: 'eq',  type: 'bool' },
        };

        const brilOp = opMap[expr.op];
        if (!brilOp) throw new Error(`Operador não mapeado: '${expr.op}'`);

        this.emit({ op: brilOp.op, dest, type: brilOp.type, args: [left, right] });
        return dest;
    }

    // ── If ────────────────────────────────────────────────────────────────────

    // COOL: if pred then e1 else e2 fi
    // Bril: br pred .then .else
    //       .then: ... id dest ← thenVal; jmp .end
    //       .else: ... id dest ← elseVal; jmp .end
    //       .end:
    transpileIf(expr) {
        const pred       = this.transpileExpr(expr.pred);
        const thenLabel  = this.freshLabel('then');
        const elseLabel  = this.freshLabel('else');
        const endLabel   = this.freshLabel('endif');
        const dest       = this.freshTemp('if');
        const resultType = this.brilType(expr.coolType || 'Object');

        // Branch condicional
        this.emit({ op: 'br', args: [pred], labels: [thenLabel, elseLabel] });

        // Bloco then
        this.emit({ label: thenLabel });
        const thenVal = this.transpileExpr(expr.thenExpr);
        this.emit({ op: 'id', dest, type: resultType, args: [thenVal] });
        this.emit({ op: 'jmp', labels: [endLabel] });

        // Bloco else
        this.emit({ label: elseLabel });
        const elseVal = this.transpileExpr(expr.elseExpr);
        this.emit({ op: 'id', dest, type: resultType, args: [elseVal] });
        this.emit({ op: 'jmp', labels: [endLabel] });

        // Ponto de encontro
        this.emit({ label: endLabel });

        return dest;
    }

    // ── While ─────────────────────────────────────────────────────────────────

    // COOL: while pred loop body pool   (retorna Object/void)
    // Bril: jmp .check
    //       .check: br pred .body .end
    //       .body:  ... body ...; jmp .check
    //       .end:   result ← 0  (void representado como int 0)
    transpileWhile(expr) {
        const checkLabel = this.freshLabel('while_check');
        const bodyLabel  = this.freshLabel('while_body');
        const endLabel   = this.freshLabel('while_end');

        // Salta para o check imediatamente
        this.emit({ op: 'jmp', labels: [checkLabel] });

        // Check — avalia predicado e decide o branch
        this.emit({ label: checkLabel });
        const pred = this.transpileExpr(expr.pred);
        this.emit({ op: 'br', args: [pred], labels: [bodyLabel, endLabel] });

        // Body — executa e volta ao check
        this.emit({ label: bodyLabel });
        this.transpileExpr(expr.body);
        this.emit({ op: 'jmp', labels: [checkLabel] });

        // End — while retorna Object (void), representado como int 0
        this.emit({ label: endLabel });
        const dest = this.freshTemp('w');
        this.emit({ op: 'const', dest, type: 'int', value: 0 });
        return dest;
    }

    // ── Block ─────────────────────────────────────────────────────────────────

    // Avalia cada expressão em ordem; retorna a variável da última
    transpileBlock(expr) {
        let last = null;
        for (const e of expr.exprs) {
            last = this.transpileExpr(e);
        }
        return last;
    }

    // ── Let ───────────────────────────────────────────────────────────────────

    // COOL: let id1:T1 <- e1, id2:T2 in body
    // Bril: instrções de init para cada binding, depois transpila o body
    // Não precisa de enterScope/exitScope — Bril é flat (SSA-like)
    transpileLet(expr) {
        for (const b of expr.bindings) {
            const type = this.brilType(b.declType);
            if (b.init) {
                const initVal = this.transpileExpr(b.init);
                this.emit({ op: 'id', dest: b.name, type, args: [initVal] });
            } else {
                // Inicialização padrão pelo tipo (§5 do manual COOL)
                this.emit({
                    op: 'const',
                    dest:  b.name,
                    type,
                    value: this.defaultValue(b.declType)
                });
            }
        }
        return this.transpileExpr(expr.body);
    }

    // ── Unários ───────────────────────────────────────────────────────────────

    // COOL ~x  →  Bril: zero = 0; dest = sub zero x
    transpileNeg(expr) {
        const val  = this.transpileExpr(expr.expr);
        const zero = this.freshTemp('z');
        const dest = this.freshTemp('n');
        this.emit({ op: 'const', dest: zero, type: 'int', value: 0 });
        this.emit({ op: 'sub', dest, type: 'int', args: [zero, val] });
        return dest;
    }

    // COOL not x  →  Bril: not dest x
    transpileNot(expr) {
        const val  = this.transpileExpr(expr.expr);
        const dest = this.freshTemp('n');
        this.emit({ op: 'not', dest, type: 'bool', args: [val] });
        return dest;
    }

    // ── Isvoid ────────────────────────────────────────────────────────────────

    // Void é representado como int 0; isvoid testa se o valor é zero
    transpileIsvoid(expr) {
        const val  = this.transpileExpr(expr.expr);
        const zero = this.freshTemp('z');
        const dest = this.freshTemp('iv');
        this.emit({ op: 'const', dest: zero, type: 'int', value: 0 });
        this.emit({ op: 'eq',    dest, type: 'bool', args: [val, zero] });
        return dest;
    }

    // ── New ───────────────────────────────────────────────────────────────────

    // Bril core não tem heap — emite const 1 (objeto non-void placeholder).
    // Uma implementação completa chamaria um alocador de memória.
    transpileNew(expr) {
        const dest = this.freshTemp('obj');
        this.emit({ op: 'const', dest, type: 'int', value: 1 });
        return dest;
    }

    // ── Dispatch ─────────────────────────────────────────────────────────────

    // Helper que monta uma instrução call Bril a partir dos componentes
    _emitCall(funcName, selfVar, argVars, coolReturnType) {
        const dest       = this.freshTemp('r');
        const returnType = this.brilType(coolReturnType || 'Object');
        const allArgs    = selfVar ? [selfVar, ...argVars] : argVars;

        // Se o tipo de retorno for Object (void no COOL), emite efeito
        // e devolve um int 0 como placeholder
        if (!coolReturnType || coolReturnType === 'Object') {
            this.emit({ op: 'call', funcs: [funcName], args: allArgs });
            this.emit({ op: 'const', dest, type: 'int', value: 0 });
        } else {
            this.emit({
                op: 'call',
                dest,
                type: returnType,
                funcs: [funcName],
                args: allArgs
            });
        }
        return dest;
    }

    // COOL: e.metodo(args)
    transpileDispatch(expr) {
        const objVar  = this.transpileExpr(expr.object);
        const argVars = expr.args.map(a => this.transpileExpr(a));
        // Resolve o tipo estático para encontrar o nome da função Bril
        const objType  = this.resolveType(expr.object.coolType);
        const funcName = `${objType}.${expr.method}`;
        return this._emitCall(funcName, objVar, argVars, expr.coolType);
    }

    // COOL: metodo(args)  →  self.metodo(args)
    transpileSelfDispatch(expr) {
        const argVars  = expr.args.map(a => this.transpileExpr(a));
        const funcName = `${this.currentCls}.${expr.method}`;
        return this._emitCall(funcName, 'self', argVars, expr.coolType);
    }

    // COOL: e@Tipo.metodo(args)  →  chama a versão específica de Tipo
    transpileStaticDispatch(expr) {
        const objVar  = this.transpileExpr(expr.object);
        const argVars = expr.args.map(a => this.transpileExpr(a));
        const funcName = `${expr.castType}.${expr.method}`;
        return this._emitCall(funcName, objVar, argVars, expr.coolType);
    }

    // ── Case ─────────────────────────────────────────────────────────────────

    // COOL case verifica o tipo dinâmico em runtime.
    // Como Bril core não tem tagged unions, simulamos com uma cadeia de
    // branches sobre uma variável _typeTag (int) que um runtime real injetaria.
    //
    // Estrutura gerada:
    //   _typeTag = id exprVar   (representação do tipo dinâmico como int)
    //   tagK = const K          (id numérico do tipo do branch K)
    //   cmpK = eq _typeTag tagK
    //   br cmpK .branchK .nextK
    //   .branchK: ... body ...; id result ← bodyVal; jmp .case_end
    //   ...
    //   .case_end:
    transpileCase(expr) {
        const exprVar  = this.transpileExpr(expr.expr);
        const endLabel = this.freshLabel('case_end');
        const dest     = this.freshTemp('case');
        const resType  = this.brilType(expr.coolType || 'Object');

        // _typeTag representa o tipo dinâmico do objeto (id do tipo como int)
        const typeTagVar = this.freshTemp('_typeTag');
        this.emit({ op: 'id', dest: typeTagVar, type: 'int', args: [exprVar] });

        expr.branches.forEach((branch, idx) => {
            const branchLabel = this.freshLabel(`case_branch_${branch.declType}`);
            const nextLabel   = this.freshLabel(`case_next_${idx}`);

            // Cada tipo recebe um id numérico (hash simples pelo índice)
            const tagConst = this.freshTemp('tag');
            this.emit({ op: 'const', dest: tagConst, type: 'int', value: idx });

            const cmpVar = this.freshTemp('cmp');
            this.emit({ op: 'eq', dest: cmpVar, type: 'bool', args: [typeTagVar, tagConst] });
            this.emit({ op: 'br', args: [cmpVar], labels: [branchLabel, nextLabel] });

            // Branch selecionado: vincula a variável do branch e avalia o body
            this.emit({ label: branchLabel });
            this.emit({ op: 'id', dest: branch.name, type: 'int', args: [exprVar] });
            const bodyVal = this.transpileExpr(branch.body);
            this.emit({ op: 'id', dest, type: resType, args: [bodyVal] });
            this.emit({ op: 'jmp', labels: [endLabel] });

            this.emit({ label: nextLabel });
        });

        // Se nenhum branch casou: emite default (runtime error real aqui)
        this.emit({ op: 'const', dest, type: resType === 'bool' ? 'bool' : 'int',
                    value: resType === 'bool' ? false : 0 });

        this.emit({ label: endLabel });
        return dest;
    }
}

module.exports = BrilTranspiler;
