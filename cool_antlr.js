import antlr4 from "antlr4";
import CoolLexer from "./CoolLexer.js";

const input = String.raw`
(* testando comentario
 em bloco *)

if(nome){ --comentário em linha
    5 + 1;
    nome.metodo(argumento);
}
`

const chars = new antlr4.InputStream(input);
const lexer = new CoolLexer(chars);

let token = lexer.nextToken();

while(token.type !== antlr4.Token.EOF) {
    console.log(
        CoolLexer.symbolicNames[token.type],
        "->",
        token.text
    );
    token = lexer.nextToken();
}