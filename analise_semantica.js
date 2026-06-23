class SemanticAnalyzer {

    constructor(ast) {
        this.ast          = ast;
        this.classTable   = {};
        this.scopes       = [];
        this.errors       = [];
        this.currentClass = null;
    }

    analyze() {
        this.buildClassTable();
        this.checkClasses();
        return this.errors;
    }

    // ─── Erros com localização ────────────────────────────────────────────────

    // Formato: "linha 10, col 5: mensagem de erro"
    // A localização fica no início — padrão de compiladores como gcc e clang.
    // node é qualquer nó da AST que tenha os campos line e col adicionados
    // pela gramática. Se não tiver, omite a localização.
    error(msg, node = null) {
        const prefix = (node?.line != null)
            ? `linha ${node.line}, col ${node.col ?? '?'}: `
            : '';
        this.errors.push(`${prefix}${msg}`);
    }

    // ─── SELF_TYPE ────────────────────────────────────────────────────────────

    // Resolve SELF_TYPE para o nome da classe atual em qualquer contexto
    resolveSelfType(type) {
        return type === 'SELF_TYPE' ? this.currentClass : type;
    }

    // ─── Escopo ────────────────────────────────────────────────────────────────

    enterScope() { this.scopes.push(new Map()); }
    exitScope()  { this.scopes.pop(); }

    addVar(name, type) {
        this.scopes.at(-1).set(name, type);
    }

    lookupVar(name) {
        for (let i = this.scopes.length - 1; i >= 0; i--) {
            if (this.scopes[i].has(name)) return this.scopes[i].get(name);
        }
        return null;
    }

    // ─── Hierarquia de tipos ───────────────────────────────────────────────────

    ancestors(type) {
        const result  = new Set();
        let current   = this.resolveSelfType(type);
        while (current) {
            result.add(current);
            current = this.classTable[current]?.parent;
        }
        return result;
    }

    conforms(child, parent) {
        const c = this.resolveSelfType(child);
        const p = this.resolveSelfType(parent);
        if (c === p)         return true;
        if (p === 'Object')  return true;
        let current = this.classTable[c]?.parent;
        while (current) {
            if (current === p) return true;
            current = this.classTable[current]?.parent;
        }
        return false;
    }

    join(typeA, typeB) {
        const ancestorsA = this.ancestors(typeA);
        let current      = this.resolveSelfType(typeB);
        while (current) {
            if (ancestorsA.has(current)) return current;
            current = this.classTable[current]?.parent;
        }
        return 'Object';
    }

    // ─── Passagem 1: tabela de classes ────────────────────────────────────────

    buildClassTable() {
        // Classes básicas com seus métodos definidos pelo manual
        const builtins = {
            Object: {
                name: 'Object', parent: null, features: [
                    { type: 'method', name: 'abort',     formals: [],                                                              returnType: 'Object'    },
                    { type: 'method', name: 'type_name', formals: [],                                                              returnType: 'String'    },
                    { type: 'method', name: 'copy',      formals: [],                                                              returnType: 'SELF_TYPE' },
                ]
            },
            IO: {
                name: 'IO', parent: 'Object', features: [
                    { type: 'method', name: 'out_string', formals: [{ name: 'x', declType: 'String' }], returnType: 'SELF_TYPE' },
                    { type: 'method', name: 'out_int',    formals: [{ name: 'x', declType: 'Int'    }], returnType: 'SELF_TYPE' },
                    { type: 'method', name: 'in_string',  formals: [],                                  returnType: 'String'    },
                    { type: 'method', name: 'in_int',     formals: [],                                  returnType: 'Int'       },
                ]
            },
            Int:  { name: 'Int',  parent: 'Object', features: [] },
            Bool: { name: 'Bool', parent: 'Object', features: [] },
            String: {
                name: 'String', parent: 'Object', features: [
                    { type: 'method', name: 'length', formals: [],                                                                                    returnType: 'Int'    },
                    { type: 'method', name: 'concat', formals: [{ name: 's', declType: 'String' }],                                                   returnType: 'String' },
                    { type: 'method', name: 'substr', formals: [{ name: 'i', declType: 'Int' }, { name: 'l', declType: 'Int' }],                      returnType: 'String' },
                ]
            },
        };
        Object.assign(this.classTable, builtins);

        // Coleta as classes do programa
        for (const cls of this.ast) {
            if (this.classTable[cls.name]) {
                this.error(`Classe '${cls.name}' já definida`, cls);
                continue;
            }
            this.classTable[cls.name] = cls;
        }

        // Verifica pais e herança proibida
        const noInherit = ['Int', 'String', 'Bool'];
        for (const cls of this.ast) {
            if (!this.classTable[cls.parent])
                this.error(`Classe '${cls.name}' herda de '${cls.parent}' que não existe`, cls);
            if (noInherit.includes(cls.parent))
                this.error(`Classe '${cls.name}' não pode herdar de '${cls.parent}'`, cls);
        }

        // Verifica ciclos na hierarquia
        for (const cls of this.ast) {
            const visited = new Set();
            let current   = cls.name;
            while (current) {
                if (visited.has(current)) {
                    this.error(`Ciclo na herança envolvendo '${cls.name}'`, cls);
                    break;
                }
                visited.add(current);
                current = this.classTable[current]?.parent;
            }
        }

        // Verifica classe Main
        if (!this.classTable['Main']) {
            this.error("Classe 'Main' não definida");
        } else {
            const mainMethod = this.classTable['Main'].features
                .find(f => f.type === 'method' && f.name === 'main');
            if (!mainMethod)
                this.error("Classe 'Main' não possui método 'main'");
            else if (mainMethod.formals.length > 0)
                this.error("Método 'main' não pode ter parâmetros", mainMethod);
        }
    }

    // ─── Override checking ─────────────────────────────────────────────────────

    checkOverride(cls) {
        for (const feature of cls.features) {
            if (feature.type !== 'method') continue;

            // Busca apenas nos ancestrais (não na classe atual)
            const parentMethod = this.lookupMethod(cls.parent, feature.name);
            if (!parentMethod) continue;   // método novo, não é override

            // Mesmo número de parâmetros
            if (feature.formals.length !== parentMethod.formals.length) {
                this.error(
                    `Override '${cls.name}.${feature.name}': ` +
                    `pai tem ${parentMethod.formals.length} parâmetro(s), ` +
                    `filho tem ${feature.formals.length}`,
                    feature
                );
                continue;
            }

            // Mesmo tipo em cada parâmetro
            for (let i = 0; i < feature.formals.length; i++) {
                const childType  = feature.formals[i].declType;
                const parentType = parentMethod.formals[i].declType;
                if (childType !== parentType)
                    this.error(
                        `Override '${cls.name}.${feature.name}': ` +
                        `parâmetro ${i + 1} é '${childType}' mas pai declara '${parentType}'`,
                        feature.formals[i]
                    );
            }

            // Mesmo tipo de retorno
            if (feature.returnType !== parentMethod.returnType)
                this.error(
                    `Override '${cls.name}.${feature.name}': ` +
                    `retorno é '${feature.returnType}' mas pai declara '${parentMethod.returnType}'`,
                    feature
                );
        }
    }

    // ─── Verificações de features ─────────────────────────────────────────────

    checkDuplicateFeatures(cls) {
        const attrNames   = new Set();
        const methodNames = new Set();
        for (const f of cls.features) {
            if (f.type === 'attribute') {
                if (attrNames.has(f.name))
                    this.error(`Atributo '${f.name}' definido mais de uma vez em '${cls.name}'`, f);
                else
                    attrNames.add(f.name);
            } else {
                if (methodNames.has(f.name))
                    this.error(`Método '${f.name}' definido mais de uma vez em '${cls.name}'`, f);
                else
                    methodNames.add(f.name);
            }
        }
    }

    checkAttributeOverride(cls) {
        for (const f of cls.features) {
            if (f.type !== 'attribute') continue;
            let ancestor = this.classTable[cls.parent];
            while (ancestor) {
                const conflict = ancestor.features?.find(
                    af => af.type === 'attribute' && af.name === f.name
                );
                if (conflict) {
                    this.error(
                        `Atributo '${f.name}' em '${cls.name}' redefine atributo herdado de '${ancestor.name}'`,
                        f
                    );
                    break;
                }
                ancestor = this.classTable[ancestor.parent];
            }
        }
    }

    // ─── Passagem 2: verificação de escopo e tipos ────────────────────────────

    // Coleta todos os atributos herdados de ancestrais (não inclui os da própria classe)
    inheritedAttributes(cls) {
        const attrs = [];
        let current = this.classTable[cls.parent];
        while (current) {
            for (const f of (current.features ?? [])) {
                if (f.type === 'attribute') attrs.unshift({ name: f.name, declType: f.declType });
            }
            current = this.classTable[current.parent];
        }
        return attrs;
    }

    checkClasses() {
        for (const cls of this.ast) {
            this.currentClass = cls.name;

            this.checkOverride(cls);
            this.checkDuplicateFeatures(cls);
            this.checkAttributeOverride(cls);

            this.enterScope();

            // self tem tipo SELF_TYPE — resolvido para o nome da classe no momento do uso
            this.addVar('self', 'SELF_TYPE');

            // Atributos herdados também são visíveis dentro da classe
            for (const inherited of this.inheritedAttributes(cls)) {
                this.addVar(inherited.name, inherited.declType);
            }

            // Atributos diretos da classe
            for (const f of cls.features) {
                if (f.type === 'attribute') {
                    if (f.name === 'self')
                        this.error(`Atributo não pode se chamar 'self'`, f);
                    const resolvedType = this.resolveSelfType(f.declType);
                    if (!this.classTable[resolvedType])
                        this.error(`Atributo '${f.name}': tipo '${f.declType}' não existe`, f);
                    this.addVar(f.name, f.declType);
                    f.coolType = f.declType;   // anota na AST
                }
            }

            for (const f of cls.features) this.checkFeature(f);

            this.exitScope();
        }
    }

    checkFeature(feature) {
        if (feature.type === 'method') {
            // SELF_TYPE é válido como retorno — só verifica se não for SELF_TYPE
            const resolvedReturn = this.resolveSelfType(feature.returnType);
            if (feature.returnType !== 'SELF_TYPE' && !this.classTable[resolvedReturn])
                this.error(
                    `Método '${feature.name}': tipo de retorno '${feature.returnType}' não existe`,
                    feature
                );

            this.enterScope();

            const seenFormals = new Set();
            for (const formal of feature.formals) {
                if (formal.name === 'self')
                    this.error(`Parâmetro não pode se chamar 'self'`, formal);
                if (seenFormals.has(formal.name))
                    this.error(`Parâmetro '${formal.name}' duplicado em '${feature.name}'`, formal);
                else
                    seenFormals.add(formal.name);
                if (formal.declType === 'SELF_TYPE')
                    this.error(`Parâmetro '${formal.name}': SELF_TYPE não é permitido como tipo de parâmetro formal`, formal);
                else if (!this.classTable[formal.declType])
                    this.error(`Parâmetro '${formal.name}': tipo '${formal.declType}' não existe`, formal);
                this.addVar(formal.name, formal.declType);
            }

            const bodyType = this.checkExpr(feature.body);

            if (!this.conforms(bodyType, feature.returnType))
                this.error(
                    `Método '${feature.name}': corpo tem tipo '${bodyType}' ` +
                    `mas declarou retornar '${feature.returnType}'`,
                    feature
                );

            feature.coolType = feature.returnType;   // anota na AST
            this.exitScope();

        } else {
            if (feature.init) {
                const initType = this.checkExpr(feature.init);
                if (!this.conforms(initType, feature.declType))
                    this.error(
                        `Atributo '${feature.name}': inicializado com '${initType}' ` +
                        `mas declarado como '${feature.declType}'`,
                        feature
                    );
            }
            feature.coolType = feature.declType;   // anota na AST
        }
    }

    // ─── Verificação de expressões ────────────────────────────────────────────

    checkExpr(expr) {
        let inferredType;

        switch (expr.type) {

            case 'int':    inferredType = 'Int';    break;
            case 'string': inferredType = 'String'; break;
            case 'bool':   inferredType = 'Bool';   break;

            case 'object': {
                const type = this.lookupVar(expr.name);
                if (!type)
                    this.error(`Identificador '${expr.name}' não declarado`, expr);
                // self retorna SELF_TYPE — será resolvido no contexto de uso
                inferredType = type || 'Object';
                break;
            }

            case 'assign': {
                if (expr.name === 'self')
                    this.error(`Não é permitido atribuir a 'self'`, expr);
                const varType  = this.lookupVar(expr.name);
                const exprType = this.checkExpr(expr.expr);
                if (!varType)
                    this.error(`Atribuição: '${expr.name}' não declarado`, expr);
                else if (!this.conforms(exprType, varType))
                    this.error(
                        `Atribuição: '${exprType}' não é compatível com '${varType}'`,
                        expr
                    );
                inferredType = exprType;
                break;
            }

            case 'binop': {
                const left  = this.checkExpr(expr.left);
                const right = this.checkExpr(expr.right);
                const arith = ['+', '-', '*', '/'];
                const comp  = ['<', '<='];
                if (arith.includes(expr.op)) {
                    if (left !== 'Int' || right !== 'Int')
                        this.error(`Operador '${expr.op}' exige Int, recebeu '${left}' e '${right}'`, expr);
                    inferredType = 'Int';
                } else if (comp.includes(expr.op)) {
                    if (left !== 'Int' || right !== 'Int')
                        this.error(`Operador '${expr.op}' exige Int, recebeu '${left}' e '${right}'`, expr);
                    inferredType = 'Bool';
                } else {
                    // '=' — básicos só comparam com o mesmo tipo
                    const basic = ['Int', 'Bool', 'String'];
                    if (basic.includes(left) || basic.includes(right))
                        if (left !== right)
                            this.error(`Operador '=': '${left}' e '${right}' devem ser do mesmo tipo`, expr);
                    inferredType = 'Bool';
                }
                break;
            }

            case 'if': {
                const pred = this.checkExpr(expr.pred);
                if (pred !== 'Bool')
                    this.error(`Predicado do 'if' deve ser Bool, recebeu '${pred}'`, expr);
                const thenType = this.checkExpr(expr.thenExpr);
                const elseType = this.checkExpr(expr.elseExpr);
                inferredType   = this.join(thenType, elseType);
                break;
            }

            case 'while': {
                const pred = this.checkExpr(expr.pred);
                if (pred !== 'Bool')
                    this.error(`Predicado do 'while' deve ser Bool, recebeu '${pred}'`, expr);
                this.checkExpr(expr.body);
                inferredType = 'Object';
                break;
            }

            case 'block': {
                let lastType = 'Object';
                for (const e of expr.exprs) lastType = this.checkExpr(e);
                inferredType = lastType;
                break;
            }

            case 'let': {
                this.enterScope();
                for (const b of expr.bindings) {
                    if (b.name === 'self')
                        this.error(`'let' não pode declarar variável chamada 'self'`, b);
                    const resolvedDecl = this.resolveSelfType(b.declType);
                    if (!this.classTable[resolvedDecl])
                        this.error(`Let: tipo '${b.declType}' não existe`, b);
                    if (b.init) {
                        const initType = this.checkExpr(b.init);
                        if (!this.conforms(initType, b.declType))
                            this.error(
                                `Let: '${b.name}' declarado como '${b.declType}' ` +
                                `mas inicializado com '${initType}'`,
                                b
                            );
                    }
                    b.coolType = b.declType;   // anota na AST
                    this.addVar(b.name, b.declType);
                }
                inferredType = this.checkExpr(expr.body);
                this.exitScope();
                break;
            }

            case 'case': {
                this.checkExpr(expr.expr);
                const seenBranchTypes = new Set();
                const branchTypes = expr.branches.map(b => {
                    if (b.name === 'self')
                        this.error(`'case' não pode declarar variável chamada 'self'`, b);
                    const resolvedType = this.resolveSelfType(b.declType);
                    if (!this.classTable[resolvedType])
                        this.error(`Case: tipo '${b.declType}' não existe`, b);
                    if (seenBranchTypes.has(b.declType))
                        this.error(`Case: tipo '${b.declType}' aparece em mais de um ramo`, b);
                    else
                        seenBranchTypes.add(b.declType);
                    this.enterScope();
                    this.addVar(b.name, b.declType);
                    const t = this.checkExpr(b.body);
                    b.coolType = b.declType;   // anota na AST
                    this.exitScope();
                    return t;
                });
                inferredType = branchTypes.reduce((acc, t) => this.join(acc, t), branchTypes[0]);
                break;
            }

            case 'new': {
                // new SELF_TYPE é válido — retorna SELF_TYPE para ser resolvido no contexto
                if (expr.typeName === 'SELF_TYPE') {
                    inferredType = 'SELF_TYPE';
                } else {
                    if (!this.classTable[expr.typeName])
                        this.error(`'new': classe '${expr.typeName}' não existe`, expr);
                    inferredType = expr.typeName;
                }
                break;
            }

            case 'neg': {
                const t = this.checkExpr(expr.expr);
                if (t !== 'Int') this.error(`'~' exige Int, recebeu '${t}'`, expr);
                inferredType = 'Int';
                break;
            }

            case 'not': {
                const t = this.checkExpr(expr.expr);
                if (t !== 'Bool') this.error(`'not' exige Bool, recebeu '${t}'`, expr);
                inferredType = 'Bool';
                break;
            }

            case 'isvoid':
                this.checkExpr(expr.expr);
                inferredType = 'Bool';
                break;

            case 'dispatch': {
                const objType     = this.checkExpr(expr.object);
                const resolvedObj = this.resolveSelfType(objType);
                const cls         = this.classTable[resolvedObj];
                if (!cls) {
                    this.error(`Dispatch: tipo '${objType}' não existe`, expr);
                    inferredType = 'Object';
                    break;
                }
                const method = this.lookupMethod(resolvedObj, expr.method);
                if (!method) {
                    this.error(`Dispatch: método '${expr.method}' não existe em '${resolvedObj}'`, expr);
                    inferredType = 'Object';
                    break;
                }
                this.checkDispatchArgs(method, expr.args, expr.method, expr);
                // Se retorna SELF_TYPE, preserva o tipo do objeto receptor
                inferredType = method.returnType === 'SELF_TYPE' ? objType : method.returnType;
                break;
            }

            case 'static_dispatch': {
                const objType = this.checkExpr(expr.object);
                if (!this.conforms(objType, expr.castType))
                    this.error(
                        `Static dispatch: '${objType}' não é compatível com '${expr.castType}'`,
                        expr
                    );
                const method = this.lookupMethod(expr.castType, expr.method);
                if (!method) {
                    this.error(`Static dispatch: método '${expr.method}' não existe em '${expr.castType}'`, expr);
                    inferredType = 'Object';
                    break;
                }
                this.checkDispatchArgs(method, expr.args, expr.method, expr);
                // SELF_TYPE retorna o tipo do receptor (e0), não o tipo do cast
                inferredType = method.returnType === 'SELF_TYPE' ? objType : method.returnType;
                break;
            }

            case 'self_dispatch': {
                const method = this.lookupMethod(this.currentClass, expr.method);
                if (!method) {
                    this.error(`Dispatch: método '${expr.method}' não existe em '${this.currentClass}'`, expr);
                    inferredType = 'Object';
                    break;
                }
                this.checkDispatchArgs(method, expr.args, expr.method, expr);
                // Preserva SELF_TYPE — o chamador é self
                inferredType = method.returnType === 'SELF_TYPE' ? 'SELF_TYPE' : method.returnType;
                break;
            }

            default:
                this.error(`Expressão desconhecida: '${expr.type}'`, expr);
                inferredType = 'Object';
        }

        expr.coolType = inferredType;   // anota o tipo inferido no nó da AST
        return inferredType;
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

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

    checkDispatchArgs(method, args, methodName, node) {
        if (args.length !== method.formals.length) {
            this.error(
                `Método '${methodName}' espera ${method.formals.length} ` +
                `argumento(s), recebeu ${args.length}`,
                node
            );
            return;
        }
        for (let i = 0; i < args.length; i++) {
            const argType    = this.checkExpr(args[i]);
            const formalType = method.formals[i].declType;
            if (!this.conforms(argType, formalType))
                this.error(
                    `Método '${methodName}': argumento ${i + 1} tem tipo '${argType}' ` +
                    `mas espera '${formalType}'`,
                    node
                );
        }
    }
}

module.exports = SemanticAnalyzer;