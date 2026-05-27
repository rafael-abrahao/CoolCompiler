class SemanticAnalyzer {

    constructor(ast) {
        this.ast        = ast;
        this.classTable = {};
        this.scopes     = [];
        this.errors     = [];
    }

    analyze() {
        this.buildClassTable();
        this.checkClasses();
        return this.errors;
    }

    error(msg) {
        this.errors.push(msg);
    }

    // ─── Escopo ────────────────────────────────────────────────────────────────

    enterScope()  { this.scopes.push(new Map()); }
    exitScope()   { this.scopes.pop(); }

    addVar(name, type) {
        this.scopes.at(-1).set(name, type);
    }

    lookupVar(name) {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            if (this.scopes[i].has(name))
                return this.scopes[i].get(name);
        }
        return null;
    }

    // ─── Hierarquia de tipos ───────────────────────────────────────────────────

    // Retorna todos os ancestrais de um tipo incluindo ele mesmo
    ancestors(type) {
        const result = new Set();
        let current = type;
        while (current) {
            result.add(current);
            current = this.classTable[current]?.parent;
        }
        return result;
    }

    // Verifica se child é igual a parent ou descende dele
    conforms(child, parent) {
        if (child === parent)  return true;
        if (parent === 'Object') return true;
        let current = this.classTable[child]?.parent;
        while (current) {
            if (current === parent) return true;
            current = this.classTable[current]?.parent;
        }
        return false;
    }

    // Ancestral comum mais próximo — usado para o tipo do if/case
    join(typeA, typeB) {
        const ancestorsA = this.ancestors(typeA);
        let current = typeB;
        while (current) {
            if (ancestorsA.has(current)) return current;
            current = this.classTable[current]?.parent;
        }
        return 'Object';
    }

    // ─── Passagem 1: tabela de classes ────────────────────────────────────────

    buildClassTable() {
        // Classes básicas do COOL
        const builtins = {
            Object: { name: 'Object', parent: null,     features: [] },
            IO:     { name: 'IO',     parent: 'Object', features: [] },
            Int:    { name: 'Int',    parent: 'Object', features: [] },
            String: { name: 'String', parent: 'Object', features: [] },
            Bool:   { name: 'Bool',   parent: 'Object', features: [] },
        };
        Object.assign(this.classTable, builtins);

        // Coleta as classes do programa
        for (const cls of this.ast) {
            if (this.classTable[cls.name]) {
                this.error(`Classe '${cls.name}' já definida`);
                continue;
            }
            this.classTable[cls.name] = cls;
        }

        // Verifica se os pais existem e se não há herança de classes básicas
        const noInherit = ['Int', 'String', 'Bool'];
        for (const cls of this.ast) {
            if (!this.classTable[cls.parent])
                this.error(`Classe '${cls.name}' herda de '${cls.parent}' que não existe`);
            if (noInherit.includes(cls.parent))
                this.error(`Classe '${cls.name}' não pode herdar de '${cls.parent}'`);
        }

        // Verifica ciclos na hierarquia
        for (const cls of this.ast) {
            const visited = new Set();
            let current = cls.name;
            while (current) {
                if (visited.has(current)) {
                    this.error(`Ciclo na herança envolvendo '${cls.name}'`);
                    break;
                }
                visited.add(current);
                current = this.classTable[current]?.parent;
            }
        }

        // Verifica se existe classe Main com método main
        if (!this.classTable['Main']) {
            this.error("Classe 'Main' não definida");
        } else {
            const mainMethod = this.classTable['Main'].features
                .find(f => f.type === 'method' && f.name === 'main');
            if (!mainMethod)
                this.error("Classe 'Main' não possui método 'main'");
            else if (mainMethod.formals.length > 0)
                this.error("Método 'main' não pode ter parâmetros");
        }
    }

    // ─── Passagem 2: verificação de escopo e tipos ────────────────────────────

    checkClasses() {
        for (const cls of this.ast) {
            this.currentClass = cls.name;
            this.enterScope();

            // self sempre disponível com o tipo da classe atual
            this.addVar('self', cls.name);

            // Atributos visíveis em toda a classe
            for (const f of cls.features) {
                if (f.type === 'attribute') {
                    if (!this.classTable[f.declType])
                        this.error(`Atributo '${f.name}': tipo '${f.declType}' não existe`);
                    this.addVar(f.name, f.declType);
                }
            }

            for (const f of cls.features)
                this.checkFeature(f);

            this.exitScope();
        }
    }

    checkFeature(feature) {
        if (feature.type === 'method') {
            // Verifica se o tipo de retorno existe
            if (!this.classTable[feature.returnType])
                this.error(`Método '${feature.name}': tipo de retorno '${feature.returnType}' não existe`);

            this.enterScope();

            // Parâmetros formais
            for (const formal of feature.formals) {
                if (!this.classTable[formal.declType])
                    this.error(`Parâmetro '${formal.name}': tipo '${formal.declType}' não existe`);
                this.addVar(formal.name, formal.declType);
            }

            const bodyType = this.checkExpr(feature.body);

            if (!this.conforms(bodyType, feature.returnType))
                this.error(
                    `Método '${feature.name}': corpo tem tipo '${bodyType}' ` +
                    `mas declarou retornar '${feature.returnType}'`
                );

            this.exitScope();

        } else {
            // Atributo com inicialização
            if (feature.init) {
                const initType = this.checkExpr(feature.init);
                if (!this.conforms(initType, feature.declType))
                    this.error(
                        `Atributo '${feature.name}': inicializado com '${initType}' ` +
                        `mas declarado como '${feature.declType}'`
                    );
            }
        }
    }

    // ─── Verificação de expressões ────────────────────────────────────────────

    checkExpr(expr) {
        switch (expr.type) {

            case 'int':    return 'Int';
            case 'string': return 'String';
            case 'bool':   return 'Bool';

            case 'object': {
                const type = this.lookupVar(expr.name);
                if (!type)
                    this.error(`Identificador '${expr.name}' não declarado`);
                return type || 'Object';
            }

            case 'assign': {
                const varType  = this.lookupVar(expr.name);
                const exprType = this.checkExpr(expr.expr);
                if (!varType)
                    this.error(`Atribuição: '${expr.name}' não declarado`);
                else if (!this.conforms(exprType, varType))
                    this.error(
                        `Atribuição: '${exprType}' não é compatível com '${varType}'`
                    );
                return exprType;
            }

            case 'binop': {
                const left  = this.checkExpr(expr.left);
                const right = this.checkExpr(expr.right);
                const arith = ['+', '-', '*', '/'];
                const comp  = ['<', '<='];

                if (arith.includes(expr.op)) {
                    if (left !== 'Int' || right !== 'Int')
                        this.error(`Operador '${expr.op}' exige Int, recebeu '${left}' e '${right}'`);
                    return 'Int';
                }
                if (comp.includes(expr.op)) {
                    if (left !== 'Int' || right !== 'Int')
                        this.error(`Operador '${expr.op}' exige Int, recebeu '${left}' e '${right}'`);
                    return 'Bool';
                }
                // '=' — Int, Bool e String só podem comparar com o mesmo tipo
                const basic = ['Int', 'Bool', 'String'];
                if (basic.includes(left) || basic.includes(right)) {
                    if (left !== right)
                        this.error(`Operador '=': '${left}' e '${right}' devem ser do mesmo tipo`);
                }
                return 'Bool';
            }

            case 'if': {
                const pred = this.checkExpr(expr.pred);
                if (pred !== 'Bool')
                    this.error(`Predicado do 'if' deve ser Bool, recebeu '${pred}'`);
                const thenType = this.checkExpr(expr.thenExpr);
                const elseType = this.checkExpr(expr.elseExpr);
                return this.join(thenType, elseType);
            }

            case 'while': {
                const pred = this.checkExpr(expr.pred);
                if (pred !== 'Bool')
                    this.error(`Predicado do 'while' deve ser Bool, recebeu '${pred}'`);
                this.checkExpr(expr.body);
                return 'Object';
            }

            case 'block': {
                let lastType = 'Object';
                for (const e of expr.exprs)
                    lastType = this.checkExpr(e);
                return lastType;
            }

            case 'let': {
                this.enterScope();
                for (const b of expr.bindings) {
                    if (!this.classTable[b.declType])
                        this.error(`Let: tipo '${b.declType}' não existe`);
                    if (b.init) {
                        const initType = this.checkExpr(b.init);
                        if (!this.conforms(initType, b.declType))
                            this.error(
                                `Let: '${b.name}' declarado como '${b.declType}' ` +
                                `mas inicializado com '${initType}'`
                            );
                    }
                    this.addVar(b.name, b.declType);
                }
                const bodyType = this.checkExpr(expr.body);
                this.exitScope();
                return bodyType;
            }

            case 'case': {
                this.checkExpr(expr.expr);
                // Tipos de cada branch para calcular o join
                const branchTypes = expr.branches.map(b => {
                    if (!this.classTable[b.declType])
                        this.error(`Case: tipo '${b.declType}' não existe`);
                    this.enterScope();
                    this.addVar(b.name, b.declType);
                    const t = this.checkExpr(b.body);
                    this.exitScope();
                    return t;
                });
                // Tipo do case = join de todos os branches
                return branchTypes.reduce((acc, t) => this.join(acc, t), branchTypes[0]);
            }

            case 'new': {
                if (!this.classTable[expr.typeName])
                    this.error(`'new': classe '${expr.typeName}' não existe`);
                return expr.typeName;
            }

            case 'neg': {
                const t = this.checkExpr(expr.expr);
                if (t !== 'Int')
                    this.error(`'~' exige Int, recebeu '${t}'`);
                return 'Int';
            }

            case 'not': {
                const t = this.checkExpr(expr.expr);
                if (t !== 'Bool')
                    this.error(`'not' exige Bool, recebeu '${t}'`);
                return 'Bool';
            }

            case 'isvoid':
                this.checkExpr(expr.expr);
                return 'Bool';

            case 'dispatch': {
                const objType = this.checkExpr(expr.object);
                const cls     = this.classTable[objType];
                if (!cls) {
                    this.error(`Dispatch: tipo '${objType}' não existe`);
                    return 'Object';
                }
                const method = this.lookupMethod(objType, expr.method);
                if (!method) {
                    this.error(`Dispatch: método '${expr.method}' não existe em '${objType}'`);
                    return 'Object';
                }
                this.checkDispatchArgs(method, expr.args, expr.method);
                return method.returnType === 'SELF_TYPE' ? objType : method.returnType;
            }

            case 'static_dispatch': {
                const objType = this.checkExpr(expr.object);
                if (!this.conforms(objType, expr.castType))
                    this.error(
                        `Static dispatch: '${objType}' não é compatível com '${expr.castType}'`
                    );
                const method = this.lookupMethod(expr.castType, expr.method);
                if (!method) {
                    this.error(`Static dispatch: método '${expr.method}' não existe em '${expr.castType}'`);
                    return 'Object';
                }
                this.checkDispatchArgs(method, expr.args, expr.method);
                return method.returnType === 'SELF_TYPE' ? expr.castType : method.returnType;
            }

            case 'self_dispatch': {
                const method = this.lookupMethod(this.currentClass, expr.method);
                if (!method) {
                    this.error(`Dispatch: método '${expr.method}' não existe em '${this.currentClass}'`);
                    return 'Object';
                }
                this.checkDispatchArgs(method, expr.args, expr.method);
                return method.returnType === 'SELF_TYPE' ? this.currentClass : method.returnType;
            }

            default:
                this.error(`Expressão desconhecida: '${expr.type}'`);
                return 'Object';
        }
    }

    // Busca um método na classe e nos seus ancestrais
    lookupMethod(className, methodName) {
        let current = className;
        while (current) {
            const cls    = this.classTable[current];
            const method = cls?.features.find(f => f.type === 'method' && f.name === methodName);
            if (method) return method;
            current = cls?.parent;
        }
        return null;
    }

    // Verifica quantidade e tipos dos argumentos de um dispatch
    checkDispatchArgs(method, args, methodName) {
        if (args.length !== method.formals.length) {
            this.error(
                `Método '${methodName}' espera ${method.formals.length} ` +
                `argumento(s), recebeu ${args.length}`
            );
            return;
        }
        for (let i = 0; i < args.length; i++) {
            const argType    = this.checkExpr(args[i]);
            const formalType = method.formals[i].declType;
            if (!this.conforms(argType, formalType))
                this.error(
                    `Método '${methodName}': argumento ${i + 1} tem tipo '${argType}' ` +
                    `mas espera '${formalType}'`
                );
        }
    }
}

module.exports = SemanticAnalyzer;