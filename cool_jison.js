var Parser = require("jison").Parser;

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

%%

[ \n\f\r\t\v]+          /* skip whitespace */

"--"[^\n]*              /* skip line comment */

"(*"                        { this.commentDepth = 1; this.begin('BLOCK_COMMENT');}

<BLOCK_COMMENT>"(*"         { this.commentDepth++;}
<BLOCK_COMMENT>"*)"         { this.commentDepth--; if(this.commentDepth === 0) this.begin('INITIAL'); }
<BLOCK_COMMENT>[^*(\n]+     /* consome texto comum */
<BLOCK_COMMENT>"*"          /* consome * isolado */
<BLOCK_COMMENT>"("          /* consome ( isolado */
<BLOCK_COMMENT>\n           /* consome quebras de linha */
<BLOCK_COMMENT><<EOF>>      { throw new Error("Comentário não fechado!"); }

"("                     return '(';
")"                     return ')';
"{"                     return '{';
"}"                     return '}';
"["                     return '[';
"]"                     return ']';

"+"                     return '+';
"-"                     return '-';
"*"                     return '*';
"/"                     return '/';

"<-"                    return '<-';
"=>"                    return '=>';

"."                     return '.';
";"                     return ';';
":"                     return ':';
"@"                     return '@';

t[rR][uU][eE]           return 'TRUE';
f[aA][lL][sS][eE]       return 'FALSE';

SELF_TYPE               return 'SELF_TYPE';

[a-z][a-zA-Z0-9_]*      return KEYWORDS[yytext.toLowerCase()] || 'OBJECTID';
[A-Z][a-zA-Z0-9_]*      return KEYWORDS[yytext.toLowerCase()] || 'TYPEID';

[0-9]+                  return 'INT';

<<EOF>>                 return 'EOF';

/lex

%start program

%%

program
    : program token
    | /* vazio */
    ;

token
    : CLASS | ELSE | FALSE | FI | IF | IN | INHERITS | ISVOID | LET | LOOP 
    | POOL | THEN | WHILE | CASE | ESAC | NEW | OF | NOT | TRUE
    | OBJECTID | TYPEID | INT | SELF_TYPE | EOF 
    | '(' | ')' | '{' | '}' | '[' | ']'
    | ';' | '.'
    | '+' | '-' | '*' | '/'
    ;
`

const parser = new Parser(grammar);

const _next = parser.lexer.next;

const symbolsInverted = Object.fromEntries(
    Object.entries(parser.symbols_).map(([name, id]) => [id, name])
);

parser.lexer.next = function() {
    const tokenId = _next.call(this);
    
    const tokenName = symbolsInverted[tokenId] || tokenId;
    if(tokenName)
        console.log(`Token: ${tokenName} -> "${this.yytext}"`);
    return tokenId;
};

teste = String.raw`
(* testando (* aninhado *) comentario
 em bloco *)

if(nome){ --comentário em linha
    5 + 1;
    nome.metodo(argumento);
}
`

parser.parse(teste);
