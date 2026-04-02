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

"~"                         return 'NOT';
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

%start program

%%

program
    : program token
    | /* vazio */
    ;

token
    : error
    ;