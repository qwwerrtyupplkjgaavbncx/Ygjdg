const express = require('express');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;
let code = require('./pair'); 

require('events').EventEmitter.defaultMaxListeners = 500;

app.use('/code', code);
app.use('/pair', async (req, res, next) => {
    res.sendFile(__path + '/pair.html')
});
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html')
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
Don't Forget To Give Star ‼️

𝙻𝙴𝙶𝙸𝙾𝙽 𝙾𝙵 𝙳𝙾𝙾𝙼 𝙼𝙸𝙽𝙸 𝙱𝙾𝚃

Server running on http://localhost:` + PORT)
});

module.exports = app;
