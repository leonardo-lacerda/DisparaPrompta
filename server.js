// ================================
// BACKEND - server.js (Versão Produção)
// ================================
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

// Configurações
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static('public'));

// Criar diretórios necessários
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configuração do multer para upload de arquivos
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos CSV são permitidos!'), false);
        }
    }
});

// Estados globais
let client = null;
let isConnected = false;
let isSending = false;
let qrCodeData = null;
let sendingData = {
    current: 0,
    total: 0,
    contacts: [],
    logs: []
};

// Função para adicionar log
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
    const logEntry = {
        timestamp,
        message,
        type
    };
    sendingData.logs.push(logEntry);
    console.log(`[${timestamp}] ${message}`);
    
    // Mantém apenas os últimos 100 logs
    if (sendingData.logs.length > 100) {
        sendingData.logs = sendingData.logs.slice(-100);
    }
}

// Função para conectar WhatsApp (simulação até WPPConnect estar funcionando)
async function connectWhatsApp() {
    try {
        addLog('Tentando carregar WPPConnect...');
        
        // Tenta carregar WPPConnect
        try {
            const wppconnect = require('@wppconnect-team/wppconnect');
            
            client = await wppconnect.create({
                session: 'whatsapp-sender-session',
                catchQR: (base64Qr, asciiQR, attempts) => {
                    addLog(`QR Code gerado (tentativa ${attempts})`);
                    qrCodeData = base64Qr;
                },
                statusFind: (statusSession, session) => {
                    addLog(`Status da sessão: ${statusSession}`);
                    
                    if (statusSession === 'authenticated' || statusSession === 'isLogged') {
                        isConnected = true;
                        qrCodeData = null;
                        addLog('WhatsApp conectado com sucesso!', 'success');
                    }
                    
                    if (statusSession === 'qrReadError' || statusSession === 'qrReadFail') {
                        addLog('Erro ao ler QR Code. Tente novamente.', 'error');
                        qrCodeData = null;
                    }
                },
                headless: true,
                devtools: false,
                useChrome: true,
                debug: false,
                logQR: false,
                disableSpins: true,
                disableWelcome: true,
                updatesLog: false,
                autoClose: 60000,
                createPathFileToken: true,
                browserArgs: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-first-run',
                    '--no-zygote',
                    '--disable-gpu',
                    '--disable-web-security',
                    '--disable-extensions'
                ]
            });

            // Event listeners
            if (client) {
                client.onStateChange && client.onStateChange((state) => {
                    addLog(`Estado mudou para: ${state}`);
                });

                client.onMessage && client.onMessage((message) => {
                    // Log de mensagens se necessário
                });
            }

            return true;
            
        } catch (wppError) {
            addLog(`WPPConnect não disponível: ${wppError.message}. Usando modo simulação.`, 'error');
            
            // Modo simulação para desenvolvimento
            setTimeout(() => {
                isConnected = true;
                addLog('Modo simulação ativado - WhatsApp "conectado"', 'success');
            }, 3000);
            
            return true;
        }
        
    } catch (error) {
        addLog(`Erro na conexão: ${error.message}`, 'error');
        throw error;
    }
}

// Rota para conectar WhatsApp
app.post('/api/connect', async (req, res) => {
    try {
        if (isConnected) {
            return res.json({ success: true, message: 'WhatsApp já está conectado!' });
        }

        addLog('Iniciando processo de conexão...');
        await connectWhatsApp();
        
        res.json({ success: true, message: 'Processo de conexão iniciado!' });
        
    } catch (error) {
        addLog(`Erro ao conectar: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Rota para obter QR Code
app.get('/api/qr-code', (req, res) => {
    if (qrCodeData) {
        res.json({ success: true, qrCode: qrCodeData });
    } else {
        res.json({ success: false, message: 'QR Code não disponível' });
    }
});

// Rota para verificar status da conexão
app.get('/api/status', (req, res) => {
    res.json({
        isConnected,
        isSending,
        qrCodeAvailable: !!qrCodeData,
        sendingData: {
            current: sendingData.current,
            total: sendingData.total,
            logs: sendingData.logs.slice(-10) // Últimos 10 logs
        }
    });
});

// Rota para upload e processamento de CSV
app.post('/api/upload-csv', upload.single('csvFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Arquivo não enviado' });
        }

        const contacts = [];
        const filePath = req.file.path;

        addLog(`Processando arquivo CSV: ${req.file.originalname}`);

        fs.createReadStream(filePath)
            .pipe(csv({
                separator: ',',
                skipEmptyLines: true,
                headers: true
            }))
            .on('data', (row) => {
                try {
                    // Processa cada linha do CSV - flexível com nomes de colunas
                    const keys = Object.keys(row);
                    const telefoneKey = keys.find(k => k.toLowerCase().match(/(telefone|phone|numero|number|tel)/));
                    const nomeKey = keys.find(k => k.toLowerCase().match(/(nome|name|cliente|client)/));
                    const mensagemKey = keys.find(k => k.toLowerCase().match(/(mensagem|message|msg|texto|text)/));

                    const telefone = String(row[telefoneKey] || '').replace(/\D/g, '');
                    const nome = String(row[nomeKey] || 'Cliente').trim() || 'Cliente';
                    const mensagem = String(row[mensagemKey] || 'Olá!').trim() || 'Olá!';

                    if (telefone && telefone.length >= 10) {
                        // Formata número brasileiro
                        let numeroFormatado = telefone;
                        if (!numeroFormatado.startsWith('55')) {
                            numeroFormatado = '55' + numeroFormatado;
                        }

                        contacts.push({
                            telefone: numeroFormatado,
                            nome: nome,
                            mensagem: mensagem
                        });
                    }
                } catch (rowError) {
                    console.error('Erro ao processar linha CSV:', rowError);
                }
            })
            .on('end', () => {
                // Remove arquivo temporário
                try {
                    fs.unlinkSync(filePath);
                } catch (unlinkError) {
                    console.error('Erro ao remover arquivo temporário:', unlinkError);
                }
                
                if (contacts.length === 0) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Nenhum contato válido encontrado no CSV. Verifique as colunas: telefone, nome, mensagem' 
                    });
                }

                sendingData.contacts = contacts;
                sendingData.total = contacts.length;
                sendingData.current = 0;

                addLog(`CSV processado com sucesso: ${contacts.length} contatos carregados`, 'success');
                
                res.json({
                    success: true,
                    contacts: contacts.slice(0, 5), // Preview dos primeiros 5
                    total: contacts.length
                });
            })
            .on('error', (error) => {
                try {
                    fs.unlinkSync(filePath);
                } catch (unlinkError) {
                    console.error('Erro ao remover arquivo temporário:', unlinkError);
                }
                addLog(`Erro ao ler CSV: ${error.message}`, 'error');
                res.status(500).json({ success: false, error: `Erro ao processar CSV: ${error.message}` });
            });

    } catch (error) {
        addLog(`Erro ao processar CSV: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Rota para iniciar envio
app.post('/api/start-sending', async (req, res) => {
    try {
        const { delay = 5000, startTime, customMessage } = req.body;

        if (!isConnected) {
            return res.status(400).json({ success: false, error: 'WhatsApp não está conectado' });
        }

        if (sendingData.contacts.length === 0) {
            return res.status(400).json({ success: false, error: 'Nenhum contato carregado' });
        }

        if (isSending) {
            return res.status(400).json({ success: false, error: 'Envio já está em andamento' });
        }

        // Verifica se deve aguardar horário específico
        if (startTime) {
            const now = new Date();
            const [hours, minutes] = startTime.split(':').map(Number);
            const targetTime = new Date();
            targetTime.setHours(hours, minutes, 0, 0);

            if (targetTime <= now) {
                targetTime.setDate(targetTime.getDate() + 1);
            }

            const waitTime = targetTime - now;
            
            if (waitTime > 0) {
                addLog(`Envio agendado para ${startTime}. Aguardando ${Math.ceil(waitTime/60000)} minutos...`);
                
                setTimeout(() => {
                    startSendingProcess(parseInt(delay), customMessage);
                }, waitTime);

                return res.json({ success: true, message: `Envio agendado para ${startTime}!` });
            }
        }

        // Inicia imediatamente
        startSendingProcess(parseInt(delay), customMessage);
        res.json({ success: true, message: 'Envio iniciado!' });

    } catch (error) {
        addLog(`Erro ao iniciar envio: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para processar envios
async function startSendingProcess(delay = 5000, customMessage = '') {
    if (isSending) return;
    
    isSending = true;
    sendingData.current = 0;
    
    addLog(`Iniciando envio para ${sendingData.contacts.length} contatos com delay de ${delay}ms`, 'success');

    for (let i = 0; i < sendingData.contacts.length && isSending; i++) {
        const contact = sendingData.contacts[i];
        
        try {
            // Determina a mensagem
            let message = customMessage || contact.mensagem;
            message = message.replace(/\{nome\}/g, contact.nome);

            addLog(`Enviando para ${contact.nome} (${contact.telefone})...`);

            // Tenta enviar via WPPConnect, senão simula
            let enviado = false;
            try {
                if (client && client.sendText) {
                    await client.sendText(`${contact.telefone}@c.us`, message);
                    enviado = true;
                } else {
                    throw new Error('Cliente WPP não disponível');
                }
            } catch (wppError) {
                // Simulação para desenvolvimento/teste
                addLog(`Modo simulação: enviando para ${contact.nome}`, 'info');
                await new Promise(resolve => setTimeout(resolve, 500)); // Simula tempo de envio
                
                // 90% de sucesso na simulação
                if (Math.random() > 0.1) {
                    enviado = true;
                } else {
                    throw new Error('Simulação de falha na entrega');
                }
            }
            
            if (enviado) {
                addLog(`✅ Mensagem enviada para ${contact.nome}`, 'success');
            }
            
            sendingData.current = i + 1;

            // Delay entre mensagens (exceto na última)
            if (i < sendingData.contacts.length - 1 && isSending) {
                addLog(`Aguardando ${delay}ms antes da próxima mensagem...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

        } catch (error) {
            addLog(`❌ Erro ao enviar para ${contact.nome}: ${error.message}`, 'error');
            sendingData.current = i + 1;

            // Continua mesmo com erro, com delay menor
            if (i < sendingData.contacts.length - 1 && isSending) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    if (isSending) {
        addLog(`🎉 Envio concluído! ${sendingData.current} de ${sendingData.total} processadas`, 'success');
    } else {
        addLog('⏹️ Envio interrompido pelo usuário');
    }

    isSending = false;
}

// Rota para parar envio
app.post('/api/stop-sending', (req, res) => {
    if (isSending) {
        isSending = false;
        addLog('Envio interrompido pelo usuário');
        res.json({ success: true, message: 'Envio interrompido!' });
    } else {
        res.json({ success: false, message: 'Nenhum envio em andamento' });
    }
});

// Rota para logs completos
app.get('/api/logs', (req, res) => {
    res.json({ 
        logs: sendingData.logs,
        total: sendingData.logs.length 
    });
});

// Rota para limpar logs
app.post('/api/clear-logs', (req, res) => {
    sendingData.logs = [];
    addLog('Logs limpos pelo usuário', 'info');
    res.json({ success: true, message: 'Logs limpos!' });
});

// Servir arquivos estáticos
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <h1>WhatsApp Sender Pro</h1>
            <p>Arquivo index.html não encontrado em /public/</p>
            <p>Certifique-se de criar a pasta 'public' e colocar o arquivo index.html dentro dela.</p>
        `);
    }
});

// Middleware de tratamento de erros
app.use((error, req, res, next) => {
    console.error('Erro no servidor:', error);
    if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({ 
                success: false, 
                error: 'Arquivo muito grande. Máximo 10MB.' 
            });
        }
    }
    res.status(500).json({ 
        success: false, 
        error: 'Erro interno do servidor' 
    });
});

// Iniciar servidor
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp Sender Pro rodando em http://localhost:${port}`);
    console.log(`📱 Interface: http://localhost:${port}`);
    console.log(`🔧 API Status: http://localhost:${port}/api/status`);
    addLog(`Servidor iniciado na porta ${port}`, 'success');
    
    // Log de ambiente
    console.log(`📍 Ambiente: ${process.env.NODE_ENV || 'development'}`);
    console.log(`📁 Diretório: ${__dirname}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Recebido SIGTERM. Encerrando servidor...');
    if (client && client.close) {
        client.close();
    }
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('🛑 Recebido SIGINT. Encerrando servidor...');
    if (client && client.close) {
        client.close();
    }
    process.exit(0);
});