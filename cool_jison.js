const Parser = require("jison").Parser;
const fs = require("fs");
const SemanticAnalyzer = require("./analise_semantica.js");

// Atalho para montar a localização a partir de um símbolo @N do Jison
// Usado em todas as ações da gramática para anotar nós com linha/coluna
function loc(jisonLoc) {
    return { line: jisonLoc.first_line, col: jisonLoc.first_column };
}

const grammar = String.raw`
%lex
%{
    const KEYWORDS = {
        class: "CLASS",
        else: "ELSE",
        fi: "FI",
        if: "IF",
        in: "IN",
        inherits: "INHERITS",
        isvoid: "ISVOID",
        let: "LET",
        loop: "LOOP",
        
        pool: "POOL",
        then: "THEN",
        while: "WHILE",
        case: "CASE",
        esac: "ESAC",
        new: "NEW",
        of: "OF",
        not: "NOT"
    };
%}

%x BLOCK_COMMENT
%x STRING

%%

[ \f\t\v]+                  /* skip whitespace */
\r?\n                       /* skip line break */

"--"[^\n]*                  /* skip line comment */

"(*"                        {
                                this.commentDepth = 1;
                                this.begin('BLOCK_COMMENT');
                            }

<BLOCK_COMMENT>"(*"         this.commentDepth++;
<BLOCK_COMMENT>"*)"         {
                                this.commentDepth--;
                                if(this.commentDepth === 0)
                                    this.popState();
                            }
<BLOCK_COMMENT><<EOF>>      throw new Error("Comentário não fechado!");
<BLOCK_COMMENT>\r?\n        /* consome quebras de linha */
<BLOCK_COMMENT>[^]          /* consome texto comum */

\"                          {
                                this.stringBuffer = "";
                                this.begin("STRING");
                            }

<STRING>\"                  {
                                this.popState();
                                yytext = this.stringBuffer;
                                return 'STRING';
                            }

<STRING>\\b                 this.stringBuffer += '\b';
<STRING>\\t                 this.stringBuffer += '\t';
<STRING>\\n                 this.stringBuffer += '\n';
<STRING>\\f                 this.stringBuffer += '\f';
<STRING>\\(.)               this.stringBuffer += yytext[1];
<STRING>\\\n                /* consome quebra de linha escapada */
<STRING>\n                  throw new Error("Unterminated string constant");
<STRING>\0                  throw new Error("String contains null character");
<STRING><<EOF>>             throw new Error("EOF in string constant");
<STRING>.                   this.stringBuffer += yytext;

"("     return '(';
")"     return ')';
"{"     return '{';
"}"     return '}';
"["     return '[';
"]"     return ']';
"+"     return '+';
"-"     return '-';
"*"     return '*';
"/"     return '/';
"<-"    return '<-';
"=>"    return '=>';
"~"     return '~';
"<="    return '<=';
"<"     return '<';
"="     return '=';
"."     return '.';
";"     return ';';
","     return ',';
":"     return ':';
"@"     return '@';

t[rR][uU][eE]               return 'TRUE';
f[aA][lL][sS][eE]           return 'FALSE';
SELF_TYPE                   return 'SELF_TYPE';

[a-z][a-zA-Z0-9_]*          return KEYWORDS[yytext.toLowerCase()] || 'OBJECTID';
[A-Z][a-zA-Z0-9_]*          return KEYWORDS[yytext.toLowerCase()] || 'TYPEID';

[0-9]+                      return 'INT';
<<EOF>>                     return 'EOF';

/lex

%right IN
%right '<-'
%left NOT
%nonassoc '<=' '<' '='
%left '+' '-'
%left '*' '/'
%left ISVOID
%left '~'
%left '@'
%left '.'

%start program

%%

program
    : class_list EOF   { return $1; }
    ;

class_list
    : class_list class ';'   { $$ = [...$1, $2]; }
    | class ';'              { $$ = [$1]; }
    ;

/*
 * @1 aponta para o token CLASS — início da declaração.
 * É o @N mais útil para erros de herança e redefinição.
 */
class
    : CLASS TYPEID '{' feature_list '}'
        { $$ = { type: 'class', name: $2, parent: 'Object', features: $4,
                 line: @1.first_line, col: @1.first_column }; }
    | CLASS TYPEID INHERITS TYPEID '{' feature_list '}'
        { $$ = { type: 'class', name: $2, parent: $4, features: $6,
                 line: @1.first_line, col: @1.first_column }; }
    ;

feature_list
    : feature_list feature ';'  { $$ = [...$1, $2]; }
    |                           { $$ = []; }
    ;

/*
 * @1 aponta para o OBJECTID (nome do método ou atributo).
 * Usado em erros de override e tipo incompatível.
 */
feature
    : OBJECTID '(' formal_list ')' ':' TYPEID '{' expr '}'
        { $$ = { type: 'method', name: $1, formals: $3, returnType: $6, body: $8,
                 line: @1.first_line, col: @1.first_column }; }
    | OBJECTID ':' TYPEID '<-' expr
        { $$ = { type: 'attribute', name: $1, declType: $3, init: $5,
                 line: @1.first_line, col: @1.first_column }; }
    | OBJECTID ':' TYPEID
        { $$ = { type: 'attribute', name: $1, declType: $3, init: null,
                 line: @1.first_line, col: @1.first_column }; }
    ;

formal_list
    : formal_list ',' formal  { $$ = [...$1, $3]; }
    | formal                  { $$ = [$1]; }
    |                         { $$ = []; }
    ;

formal
    : OBJECTID ':' TYPEID
        { $$ = { name: $1, declType: $3,
                 line: @1.first_line, col: @1.first_column }; }
    ;

expr
    /*
     * Atribuição — @1 aponta para o OBJECTID do lado esquerdo
     */
    : OBJECTID '<-' expr
        { $$ = { type: 'assign', name: $1, expr: $3,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * Dispatch normal — @2 aponta para o '.' que separa objeto de método.
     * É o ponto mais preciso para erros como "método não existe".
     */
    | expr '.' OBJECTID '(' arg_list ')'
        { $$ = { type: 'dispatch', object: $1, method: $3, args: $5,
                 line: @2.first_line, col: @2.first_column }; }

    /*
     * Static dispatch — @2 aponta para o '@'
     */
    | expr '@' TYPEID '.' OBJECTID '(' arg_list ')'
        { $$ = { type: 'static_dispatch', object: $1, castType: $3, method: $5, args: $7,
                 line: @2.first_line, col: @2.first_column }; }

    /*
     * Self dispatch — @1 aponta para o nome do método
     */
    | OBJECTID '(' arg_list ')'
        { $$ = { type: 'self_dispatch', method: $1, args: $3,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * If — @1 aponta para o token IF
     */
    | IF expr THEN expr ELSE expr FI
        { $$ = { type: 'if', pred: $2, thenExpr: $4, elseExpr: $6,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * While — @1 aponta para o token WHILE
     */
    | WHILE expr LOOP expr POOL
        { $$ = { type: 'while', pred: $2, body: $4,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * Bloco — @1 aponta para a chave de abertura '{'
     */
    | '{' block_expr_list '}'
        { $$ = { type: 'block', exprs: $2,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * Let — @1 aponta para o token LET
     */
    | LET let_binding_list IN expr %prec IN
        { $$ = { type: 'let', bindings: $2, body: $4,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * Case — @1 aponta para o token CASE
     */
    | CASE expr OF case_branch_list ESAC
        { $$ = { type: 'case', expr: $2, branches: $4,
                 line: @1.first_line, col: @1.first_column }; }

    /*
     * Operadores binários — @2 aponta para o operador em si,
     * que é o ponto mais útil para erros de tipo incompatível.
     */
    | expr '+' expr   { $$ = { type: 'binop', op: '+', left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '-' expr   { $$ = { type: 'binop', op: '-', left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '*' expr   { $$ = { type: 'binop', op: '*', left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '/' expr   { $$ = { type: 'binop', op: '/', left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '<' expr   { $$ = { type: 'binop', op: '<',  left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '<=' expr  { $$ = { type: 'binop', op: '<=', left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }
    | expr '=' expr   { $$ = { type: 'binop', op: '=',  left: $1, right: $3,
                                line: @2.first_line, col: @2.first_column }; }

    /*
     * Operadores unários — @1 aponta para o operador
     */
    | '~' expr        { $$ = { type: 'neg',    expr: $2,
                                line: @1.first_line, col: @1.first_column }; }
    | NOT expr        { $$ = { type: 'not',    expr: $2,
                                line: @1.first_line, col: @1.first_column }; }
    | ISVOID expr     { $$ = { type: 'isvoid', expr: $2,
                                line: @1.first_line, col: @1.first_column }; }

    /*
     * New — @1 aponta para o token NEW
     */
    | NEW TYPEID      { $$ = { type: 'new', typeName: $2,
                                line: @1.first_line, col: @1.first_column }; }

    /*
     * Parênteses — transparente, propaga o loc da expr interna
     */
    | '(' expr ')'    { $$ = $2; }

    /*
     * Literais e identificadores — @1 aponta para o token em si
     */
    | OBJECTID        { $$ = { type: 'object', name: $1,
                                line: @1.first_line, col: @1.first_column }; }
    | INT             { $$ = { type: 'int',    value: Number($1),
                                line: @1.first_line, col: @1.first_column }; }
    | STRING          { $$ = { type: 'string', value: $1,
                                line: @1.first_line, col: @1.first_column }; }
    | TRUE            { $$ = { type: 'bool',   value: true,
                                line: @1.first_line, col: @1.first_column }; }
    | FALSE           { $$ = { type: 'bool',   value: false,
                                line: @1.first_line, col: @1.first_column }; }
    ;

arg_list
    : arg_list ',' expr   { $$ = [...$1, $3]; }
    | expr                { $$ = [$1]; }
    |                     { $$ = []; }
    ;

let_binding_list
    : let_binding_list ',' let_binding  { $$ = [...$1, $3]; }
    | let_binding                       { $$ = [$1]; }
    ;

/*
 * @1 aponta para o OBJECTID do binding — nome da variável declarada
 */
let_binding
    : OBJECTID ':' TYPEID '<-' expr
        { $$ = { name: $1, declType: $3, init: $5,
                 line: @1.first_line, col: @1.first_column }; }
    | OBJECTID ':' TYPEID
        { $$ = { name: $1, declType: $3, init: null,
                 line: @1.first_line, col: @1.first_column }; }
    ;

case_branch_list
    : case_branch_list case_branch ';'  { $$ = [...$1, $2]; }
    | case_branch ';'                   { $$ = [$1]; }
    ;

/*
 * @1 aponta para o OBJECTID do branch — nome da variável do case
 */
case_branch
    : OBJECTID ':' TYPEID '=>' expr
        { $$ = { name: $1, declType: $3, body: $5,
                 line: @1.first_line, col: @1.first_column }; }
    ;

block_expr_list
    : block_expr_list expr ';'  { $$ = [...$1, $2]; }
    | expr ';'                  { $$ = [$1]; }
    ;
`;

const parser = new Parser(grammar);

const file = process.argv[2];
if (!file) {
    console.error("Uso: node cool_jison.js <arquivo.cool>");
    process.exit(1);
}

const input = fs.readFileSync(file, "utf8");

let ast;
try {
    ast = parser.parse(input);
} catch (e) {
    console.error(`Erro sintático: ${e.message}`);
    process.exit(1);
}

const errors = new SemanticAnalyzer(ast).analyze();

if (errors.length > 0) {
    console.log("Erros semânticos encontrados:");
    errors.forEach(e => console.log(` • ${e}`));
    process.exit(1);
} else {
    console.log("Análise semântica ok");
    const outFile = file.replace(".cool", ".ast.json");
    fs.writeFileSync(outFile, JSON.stringify(ast, null, 2), "utf8");
    console.log(`AST salva em ${outFile}`);
}
