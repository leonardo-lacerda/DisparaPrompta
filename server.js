// ================================
// BACKEND - server.js
// ================================
const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const { create, Whatsapp } = require('@wppconnect-team/wppconnect');

const app = express();
const port = 3000;

// Configurações
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuração do multer para upload de arquivos
const upload = multer({ dest: 'uploads/' });

// Estados globais
let client = null;
let isConnected = false;
let isSending = false;
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

// Rota para conectar WhatsApp
app.post('/api/connect', async (req, res) => {
    try {
        if (isConnected) {
            return res.json({ success: true, message: 'WhatsApp já está conectado!' });
        }

        addLog('Iniciando conexão com WhatsApp...');
        
        client = await create({
            session: 'whatsapp-sender',
            catchQR: (base64Qr, asciiQR) => {
                // QR Code será enviado via WebSocket ou polling
                console.log('QR Code gerado!');
            },
            statusFind: (statusSession, session) => {
                addLog(`Status da sessão: ${statusSession}`);
                
                if (statusSession === 'authenticated') {
                    isConnected = true;
                    addLog('WhatsApp conectado com sucesso!', 'success');
                }
            },
            headless: true, // Para servidor
            devtools: false,
            useChrome: true,
            debug: false,
            logQR: false,
            browserWS: '',
            browserArgs: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        });

        // Event listeners
        client.onStateChange((state) => {
            addLog(`Estado mudou para: ${state}`);
        });

        client.onMessage((message) => {
            // Log de mensagens recebidas se necessário
        });

        res.json({ success: true, message: 'Processo de conexão iniciado!' });
        
    } catch (error) {
        addLog(`Erro ao conectar: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Rota para verificar status da conexão
app.get('/api/status', (req, res) => {
    res.json({
        isConnected,
        isSending,
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

        fs.createReadStream(filePath)
            .pipe(csv())
            .on('data', (row) => {
                // Processa cada linha do CSV
                const telefone = String(row.telefone || row.phone || row.numero || '').replace(/\D/g, '');
                const nome = row.nome || row.name || row.cliente || 'Cliente';
                const mensagem = row.mensagem || row.message || row.msg || 'Olá!';

                if (telefone && telefone.length >= 10) {
                    contacts.push({
                        telefone: telefone.startsWith('55') ? telefone : '55' + telefone,
                        nome: nome.trim(),
                        mensagem: mensagem.trim()
                    });
                }
            })
            .on('end', () => {
                // Remove arquivo temporário
                fs.unlinkSync(filePath);
                
                if (contacts.length === 0) {
                    return res.status(400).json({ 
                        success: false, 
                        error: 'Nenhum contato válido encontrado no CSV' 
                    });
                }

                sendingData.contacts = contacts;
                sendingData.total = contacts.length;
                sendingData.current = 0;

                addLog(`CSV processado: ${contacts.length} contatos carregados`, 'success');
                
                res.json({
                    success: true,
                    contacts: contacts.slice(0, 5), // Preview dos primeiros 5
                    total: contacts.length
                });
            })
            .on('error', (error) => {
                fs.unlinkSync(filePath);
                res.status(500).json({ success: false, error: error.message });
            });

    } catch (error) {
        addLog(`Erro ao processar CSV: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Rota para iniciar envio
app.post('/api/start-sending', async (req, res) => {
    try {
        const { delay, startTime, customMessage } = req.body;

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
                addLog(`Aguardando horário programado: ${startTime}. Faltam ${Math.ceil(waitTime/60000)} minutos.`);
                
                setTimeout(() => {
                    startSendingProcess(delay, customMessage);
                }, waitTime);

                return res.json({ success: true, message: 'Envio programado com sucesso!' });
            }
        }

        // Inicia imediatamente
        startSendingProcess(delay, customMessage);
        res.json({ success: true, message: 'Envio iniciado!' });

    } catch (error) {
        addLog(`Erro ao iniciar envio: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para processar envios
async function startSendingProcess(delay = 5000, customMessage = '') {
    isSending = true;
    sendingData.current = 0;
    
    addLog('Iniciando processo de envio...', 'success');

    for (let i = 0; i < sendingData.contacts.length && isSending; i++) {
        const contact = sendingData.contacts[i];
        
        try {
            // Determina a mensagem
            let message = customMessage || contact.mensagem;
            message = message.replace(/\{nome\}/g, contact.nome);

            addLog(`Enviando para ${contact.nome} (${contact.telefone})...`);

            // Envia a mensagem
            await client.sendText(`${contact.telefone}@c.us`, message);
            
            addLog(`✅ Mensagem enviada para ${contact.nome}`, 'success');
            sendingData.current = i + 1;

            // Delay entre mensagens
            if (i < sendingData.contacts.length - 1 && isSending) {
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
        addLog('🎉 Envio concluído com sucesso!', 'success');
    } else {
        addLog('⏹️ Envio interrompido pelo usuário');
    }

    isSending = false;
}

// Rota para parar envio
app.post('/api/stop-sending', (req, res) => {
    isSending = false;
    addLog('Envio interrompido pelo usuário');
    res.json({ success: true, message: 'Envio interrompido!' });
});

// Rota para logs
app.get('/api/logs', (req, res) => {
    res.json({ logs: sendingData.logs });
});

// Servir arquivos estáticos
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
    console.log(`🚀 Servidor rodando em http://localhost:${port}`);
    addLog(`Servidor iniciado na porta ${port}`, 'success');
});

// ================================
// FRONTEND - public/index.html
// ================================
