const Parser = require("jison").Parser;
const fs = require("fs");

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
<BLOCK_COMMENT>\r?\n        /*git  consome quebras de linha */
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

"("                         return '(';
")"                         return ')';
"{"                         return '{';
"}"                         return '}';
"["                         return '[';
"]"                         return ']';

"+"                         return '+';
"-"                         return '-';
"*"                         return '*';
"/"                         return '/';

"<-"                        return '<-';
"=>"                        return '=>';

"~"                         return '~';
"<="                        return '<=';
"<"                         return '<';
"="                         return '=';

"."                         return '.';
";"                         return ';';
","                         return ',';
":"                         return ':';
"@"                         return '@';

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

class
    : CLASS TYPEID '{' feature_list '}'
        { $$ = { type: 'class', name: $2, parent: 'Object', features: $4 }; }
    | CLASS TYPEID INHERITS TYPEID '{' feature_list '}'
        { $$ = { type: 'class', name: $2, parent: $4, features: $6 }; }
    ;

feature_list
    : feature_list feature ';'  { $$ = [...$1, $2]; }
    |                           { $$ = []; }
    ;

/* Um feature é um método ou um atributo */
feature
    : OBJECTID '(' formal_list ')' ':' TYPEID '{' expr '}'
        { $$ = { type: 'method', name: $1, formals: $3, returnType: $6, body: $8 }; }
    | OBJECTID ':' TYPEID '<-' expr
        { $$ = { type: 'attribute', name: $1, declType: $3, init: $5 }; }
    | OBJECTID ':' TYPEID
        { $$ = { type: 'attribute', name: $1, declType: $3, init: null }; }
    ;

formal_list
    : formal_list ',' formal  { $$ = [...$1, $3]; }
    | formal                  { $$ = [$1]; }
    |                         { $$ = []; }
    ;

formal
    : OBJECTID ':' TYPEID
        { $$ = { name: $1, declType: $3 }; }
    ;

expr
    /* Atribuição */
    : OBJECTID '<-' expr
        { $$ = { type: 'assign', name: $1, expr: $3 }; }

    /* Dispatch */
    | expr '.' OBJECTID '(' arg_list ')'
        { $$ = { type: 'dispatch', object: $1, method: $3, args: $5}; }
    | expr '@' TYPEID '.' OBJECTID '(' arg_list ')'
        { $$ = { type: 'static_dispatch', object: $1, castType: $3, method: $5, args: $7}; }
    | OBJECTID '(' arg_list ')'
        { $$ = { type: 'self_dispatch', method: $1, args: $3}; }

    /* If */
    | IF expr THEN expr ELSE expr FI
        { $$ = { type: 'if', pred: $2, thenExpr: $4, elseExpr: $6 }; }

    /* While */
    | WHILE expr LOOP expr POOL
        { $$ = { type: 'while', pred: $2, body: $4 }; }

    /* Bloco */
    | '{' block_expr_list '}'
        { $$ = { type: 'block', exprs: $2 }; }

    /* Let */
    | LET let_binding_list IN expr %prec IN
        { $$ = { type: 'let', bindings: $2, body: $4 }; }

    /* Case */
    | CASE expr OF case_branch_list ESAC
        { $$ = { type: 'case', expr: $2, branches: $4 }; }

    /* Operações aritméticas e comparações */
    | expr '+' expr   { $$ = { type: 'binop', op: '+', left: $1, right: $3 }; }
    | expr '-' expr   { $$ = { type: 'binop', op: '-', left: $1, right: $3 }; }
    | expr '*' expr   { $$ = { type: 'binop', op: '*', left: $1, right: $3 }; }
    | expr '/' expr   { $$ = { type: 'binop', op: '/', left: $1, right: $3 }; }
    | expr '<' expr   { $$ = { type: 'binop', op: '<',  left: $1, right: $3 }; }
    | expr '<=' expr  { $$ = { type: 'binop', op: '<=', left: $1, right: $3 }; }
    | expr '=' expr   { $$ = { type: 'binop', op: '=',  left: $1, right: $3 }; }

    /* Unários */
    | '~' expr        { $$ = { type: 'neg',    expr: $2 }; }
    | NOT expr        { $$ = { type: 'not',    expr: $2 }; }
    | ISVOID expr     { $$ = { type: 'isvoid', expr: $2 }; }

    /* new */
    | NEW TYPEID      { $$ = { type: 'new', typeName: $2 }; }

    /* Parênteses */
    | '(' expr ')'    { $$ = $2; }

    /* Literais e identificadores */
    | OBJECTID        { $$ = { type: 'object', name: $1 }; }
    | INT             { $$ = { type: 'int',    value: Number($1) }; }
    | STRING          { $$ = { type: 'string', value: $1 }; }
    | TRUE            { $$ = { type: 'bool',   value: true }; }
    | FALSE           { $$ = { type: 'bool',   value: false }; }
    ;

arg_list
    : arg_list ',' expr                 {$$ = [...$1, $3]; }
    | expr                              {$$ = [$1]; }
    |                                   {$$ = []; }
    ;

let_binding_list
    : let_binding_list ',' let_binding  {$$ = [...$1, $3]; }
    | let_binding                       {$$ = [$1]; }
    ;

let_binding
    : OBJECTID ':' TYPEID '<-' expr
        { $$ = { name: $1, declType: $3, init: $5 }; }
    | OBJECTID ':' TYPEID
        { $$ = { name: $1, declType: $3, init: null }; }
    ;

case_branch_list
    : case_branch_list case_branch ';'  { $$ = [...$1, $2]; }
    | case_branch ';'                   { $$ = [$1]; }
    ;

case_branch
    : OBJECTID ':' TYPEID '=>' expr     
        { $$ = { name: $1, declType: $3, body: $5}; }
    ;

block_expr_list
    : block_expr_list expr ';'          { $$ = [...$1, $2]; }
    | expr ';'                          { $$ = [$1]; }
    ;
`

const parser = new Parser(grammar);

const exemplo_completo = fs.readFileSync("exemplo_completo.cool", "utf8");
const exemplo_basico = fs.readFileSync("exemplo_basico.cool", "utf8");

const result = parser.parse(exemplo_basico);
console.log(JSON.stringify(result, null, 2));
