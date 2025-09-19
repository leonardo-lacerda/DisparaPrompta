// ================================
// WhatsApp Sender Pro - Cloud Optimized
// ================================
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const port = process.env.PORT || 3000;

console.log('🚀 Iniciando WhatsApp Sender Pro...');
console.log(`📍 Porta: ${port}`);
console.log(`🌍 Ambiente: ${process.env.NODE_ENV || 'production'}`);

// Configurações básicas
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Middleware para logs
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Criar diretórios necessários
const directories = ['public', 'uploads', 'temp'];
directories.forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`📁 Criado diretório: ${dir}`);
    }
});

// Configuração do multer - storage em memória para cloud
const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
    fileFilter: (req, file, cb) => {
        if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
            cb(null, true);
        } else {
            cb(new Error('Apenas arquivos CSV são permitidos!'), false);
        }
    }
});

// Estados da aplicação
let appState = {
    isConnected: false,
    isSending: false,
    qrCode: null,
    sendingData: {
        current: 0,
        total: 0,
        contacts: [],
        logs: []
    }
};

// Sistema de logs
function addLog(message, type = 'info') {
    const timestamp = new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
    
    const logEntry = {
        timestamp,
        message,
        type,
        id: Date.now()
    };
    
    appState.sendingData.logs.unshift(logEntry);
    console.log(`[${timestamp}] [${type.toUpperCase()}] ${message}`);
    
    // Manter apenas os últimos 50 logs
    if (appState.sendingData.logs.length > 50) {
        appState.sendingData.logs = appState.sendingData.logs.slice(0, 50);
    }
}

// Função para conectar WhatsApp
async function connectWhatsApp() {
    try {
        addLog('Tentando conectar WhatsApp...');
        
        // Tenta carregar WPPConnect se disponível
        let wppconnect = null;
        try {
            wppconnect = require('@wppconnect-team/wppconnect');
        } catch (e) {
            addLog('WPPConnect não encontrado. Usando modo simulação.', 'info');
        }
        
        if (wppconnect) {
            // Conecta WPPConnect real
            const client = await wppconnect.create({
                session: 'sender-session',
                catchQR: (base64Qr) => {
                    appState.qrCode = base64Qr;
                    addLog('QR Code gerado. Escaneie com seu WhatsApp.');
                },
                statusFind: (status) => {
                    addLog(`Status: ${status}`);
                    if (status === 'authenticated' || status === 'isLogged') {
                        appState.isConnected = true;
                        appState.qrCode = null;
                        addLog('✅ WhatsApp conectado!', 'success');
                    }
                },
                headless: true,
                devtools: false,
                debug: false,
                logQR: false,
                browserArgs: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu'
                ]
            });
            
            return client;
        } else {
            // Modo simulação
            setTimeout(() => {
                appState.isConnected = true;
                addLog('✅ Modo simulação ativado', 'success');
            }, 2000);
            return null;
        }
        
    } catch (error) {
        addLog(`❌ Erro na conexão: ${error.message}`, 'error');
        throw error;
    }
}

let whatsappClient = null;

// ================================
// ROTAS DA API
// ================================

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Conectar WhatsApp
app.post('/api/connect', async (req, res) => {
    try {
        if (appState.isConnected) {
            return res.json({ success: true, message: 'WhatsApp já conectado!' });
        }
        
        whatsappClient = await connectWhatsApp();
        res.json({ success: true, message: 'Conexão iniciada!' });
        
    } catch (error) {
        addLog(`Erro ao conectar: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Status do sistema
app.get('/api/status', (req, res) => {
    res.json({
        isConnected: appState.isConnected,
        isSending: appState.isSending,
        qrCode: appState.qrCode,
        sendingData: {
            current: appState.sendingData.current,
            total: appState.sendingData.total,
            logs: appState.sendingData.logs.slice(0, 10)
        }
    });
});

// Upload CSV
app.post('/api/upload-csv', upload.single('csvFile'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'Arquivo não enviado' });
        }
        
        const csvData = req.file.buffer.toString('utf8');
        const lines = csvData.split('\n').filter(line => line.trim());
        
        if (lines.length < 2) {
            return res.status(400).json({ 
                success: false, 
                error: 'CSV deve ter pelo menos 2 linhas (cabeçalho + dados)' 
            });
        }
        
        const contacts = [];
        
        // Processa CSV manualmente
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        
        for (let i = 1; i < lines.length; i++) {
            const values = lines[i].split(',').map(v => v.trim().replace(/"/g, ''));
            
            if (values.length >= 2) {
                const telefone = values[0].replace(/\D/g, '');
                const nome = values[1] || 'Cliente';
                const mensagem = values[2] || 'Olá!';
                
                if (telefone.length >= 10) {
                    contacts.push({
                        telefone: telefone.startsWith('55') ? telefone : '55' + telefone,
                        nome: nome,
                        mensagem: mensagem
                    });
                }
            }
        }
        
        if (contacts.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Nenhum contato válido encontrado' 
            });
        }
        
        appState.sendingData.contacts = contacts;
        appState.sendingData.total = contacts.length;
        appState.sendingData.current = 0;
        
        addLog(`📁 CSV carregado: ${contacts.length} contatos`, 'success');
        
        res.json({
            success: true,
            contacts: contacts.slice(0, 5),
            total: contacts.length
        });
        
    } catch (error) {
        addLog(`❌ Erro no CSV: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar envio
app.post('/api/start-sending', async (req, res) => {
    try {
        const { delay = 5000, startTime, customMessage } = req.body;
        
        if (!appState.isConnected) {
            return res.status(400).json({ 
                success: false, 
                error: 'WhatsApp não conectado' 
            });
        }
        
        if (appState.sendingData.contacts.length === 0) {
            return res.status(400).json({ 
                success: false, 
                error: 'Nenhum contato carregado' 
            });
        }
        
        if (appState.isSending) {
            return res.status(400).json({ 
                success: false, 
                error: 'Envio já em andamento' 
            });
        }
        
        // Agendamento
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
                addLog(`⏰ Agendado para ${startTime}. Aguardando...`);
                setTimeout(() => startSending(parseInt(delay), customMessage), waitTime);
                return res.json({ success: true, message: `Agendado para ${startTime}` });
            }
        }
        
        // Inicia imediatamente
        startSending(parseInt(delay), customMessage);
        res.json({ success: true, message: 'Envio iniciado!' });
        
    } catch (error) {
        addLog(`❌ Erro ao iniciar: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Parar envio
app.post('/api/stop-sending', (req, res) => {
    appState.isSending = false;
    addLog('⏹️ Envio interrompido pelo usuário');
    res.json({ success: true, message: 'Envio parado!' });
});

// ================================
// FUNÇÃO DE ENVIO
// ================================
async function startSending(delay, customMessage) {
    appState.isSending = true;
    appState.sendingData.current = 0;
    
    addLog(`🚀 Iniciando envio para ${appState.sendingData.contacts.length} contatos`, 'success');
    
    for (let i = 0; i < appState.sendingData.contacts.length && appState.isSending; i++) {
        const contact = appState.sendingData.contacts[i];
        
        try {
            let message = customMessage || contact.mensagem;
            message = message.replace(/\{nome\}/g, contact.nome);
            
            addLog(`📤 Enviando para ${contact.nome}...`);
            
            // Tenta envio real ou simula
            if (whatsappClient && whatsappClient.sendText) {
                await whatsappClient.sendText(`${contact.telefone}@c.us`, message);
            } else {
                // Simulação
                await new Promise(resolve => setTimeout(resolve, 500));
                if (Math.random() < 0.05) { // 5% de falha
                    throw new Error('Falha simulada');
                }
            }
            
            addLog(`✅ Enviado para ${contact.nome}`, 'success');
            appState.sendingData.current = i + 1;
            
            // Delay entre mensagens
            if (i < appState.sendingData.contacts.length - 1 && appState.isSending) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
            
        } catch (error) {
            addLog(`❌ Falha para ${contact.nome}: ${error.message}`, 'error');
            appState.sendingData.current = i + 1;
            
            // Continua com delay menor
            if (i < appState.sendingData.contacts.length - 1 && appState.isSending) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    
    if (appState.isSending) {
        addLog(`🎉 Envio concluído! ${appState.sendingData.current}/${appState.sendingData.total}`, 'success');
    }
    
    appState.isSending = false;
}

// ================================
// SERVIR ARQUIVOS ESTÁTICOS
// ================================
app.use(express.static('public'));

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Sender Pro</title>
                <style>
                    body { font-family: Arial; margin: 40px; background: #f5f5f5; }
                    .container { max-width: 600px; margin: 0 auto; background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                    h1 { color: #25d366; }
                    .status { padding: 15px; background: #e8f5e8; border-radius: 5px; margin: 20px 0; }
                    a { color: #25d366; text-decoration: none; }
                    code { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>📱 WhatsApp Sender Pro</h1>
                    <div class="status">
                        ✅ Servidor rodando com sucesso!<br>
                        🚀 Status: <strong>Online</strong><br>
                        📍 Porta: <strong>${port}</strong>
                    </div>
                    <p><strong>📁 Para usar a interface completa:</strong></p>
                    <ol>
                        <li>Crie a pasta <code>public</code></li>
                        <li>Coloque o arquivo <code>index.html</code> dentro dela</li>
                        <li>Reinicie o servidor</li>
                    </ol>
                    <p><strong>🔗 APIs disponíveis:</strong></p>
                    <ul>
                        <li><a href="/api/status">Status do sistema</a></li>
                        <li><a href="/health">Health check</a></li>
                    </ul>
                </div>
            </body>
            </html>
        `);
    }
});

// Middleware de erro
app.use((error, req, res, next) => {
    console.error('❌ Erro no servidor:', error);
    res.status(500).json({ 
        success: false, 
        error: 'Erro interno do servidor' 
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'Endpoint não encontrado' 
    });
});

// ================================
// INICIAR SERVIDOR
// ================================
const server = app.listen(port, '0.0.0.0', () => {
    console.log(`✅ Servidor rodando!`);
    console.log(`🌐 URL: http://localhost:${port}`);
    console.log(`📊 Status: http://localhost:${port}/api/status`);
    console.log(`❤️ Health: http://localhost:${port}/health`);
    addLog(`Servidor iniciado na porta ${port}`, 'success');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM recebido. Encerrando...');
    server.close(() => {
        if (whatsappClient && whatsappClient.close) {
            whatsappClient.close();
        }
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT recebido. Encerrando...');
    server.close(() => {
        if (whatsappClient && whatsappClient.close) {
            whatsappClient.close();
        }
        process.exit(0);
    });
});

// Log inicial
addLog('WhatsApp Sender Pro inicializado', 'success');