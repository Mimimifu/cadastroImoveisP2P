// server.js - Servidor Socket.IO com suporte a salas
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// Configuração do Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*", // Em produção, restrinja para seu domínio
        methods: ["GET", "POST"],
        allowedHeaders: ["*"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================
// CONFIGURAÇÃO SUPABASE (opcional)
// ============================================
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';
let supabaseClient = null;

if (supabaseUrl && supabaseKey) {
    supabaseClient = createClient(supabaseUrl, supabaseKey);
    console.log('✅ Supabase configurado');
} else {
    console.log('⚠️ Supabase não configurado (variáveis de ambiente ausentes)');
}

// ============================================
// ARMAZENAMENTO EM MEMÓRIA (fallback)
// ============================================
// Estrutura: { sala: { dados: [], clientes: [] } }
const salasData = new Map();

// ============================================
// FUNÇÕES AUXILIARES
// ============================================
async function salvarDadosSala(sala, dados) {
    // Salvar em memória
    if (!salasData.has(sala)) {
        salasData.set(sala, { dados: [], clientes: [] });
    }
    salasData.get(sala).dados = dados;

    // Salvar no Supabase se disponível
    if (supabaseClient) {
        try {
            // Buscar dados existentes
            const { data: existing, error: fetchError } = await supabaseClient
                .from('imoveis')
                .select('*')
                .eq('sala', sala);

            if (fetchError) {
                console.error('❌ Erro ao buscar dados do Supabase:', fetchError);
                return;
            }

            // Para cada imóvel, fazer upsert com a sala
            for (const item of dados) {
                const { error } = await supabaseClient
                    .from('imoveis')
                    .upsert({
                        id: item.id,
                        sala: sala,
                        titulo: item.titulo,
                        tipo: item.tipo,
                        quartos: Number(item.quartos) || 0,
                        banheiros: Number(item.banheiros) || 0,
                        area: Number(item.area) || 0,
                        endereco: item.endereco || '',
                        preco: Number(item.preco) || 0,
                        contato: item.contato || '',
                        qrcode: item.qrcode || '',
                        img: item.img || null,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'id' });

                if (error) {
                    console.error(`❌ Erro ao salvar item ${item.id}:`, error);
                }
            }
            console.log(`✅ Dados da sala "${sala}" salvos no Supabase`);
        } catch (err) {
            console.error('❌ Erro ao salvar no Supabase:', err);
        }
    }
}

async function carregarDadosSala(sala) {
    // Tentar carregar do Supabase primeiro
    if (supabaseClient) {
        try {
            const { data, error } = await supabaseClient
                .from('imoveis')
                .select('*')
                .eq('sala', sala);

            if (error) {
                console.error('❌ Erro ao carregar do Supabase:', error);
                // Fallback para memória
                if (salasData.has(sala)) {
                    return salasData.get(sala).dados;
                }
                return [];
            }

            if (data && data.length > 0) {
                const imoveis = data.map(item => ({
                    id: item.id || item.imovel_id,
                    titulo: item.titulo || 'Sem título',
                    tipo: item.tipo || 'Casa',
                    quartos: item.quartos || 0,
                    banheiros: item.banheiros || 0,
                    area: item.area || 0,
                    endereco: item.endereco || '',
                    preco: item.preco || 0,
                    contato: item.contato || '',
                    qrcode: item.qrcode || '',
                    img: item.img || null
                }));
                
                // Atualizar cache em memória
                if (!salasData.has(sala)) {
                    salasData.set(sala, { dados: [], clientes: [] });
                }
                salasData.get(sala).dados = imoveis;
                
                return imoveis;
            }
        } catch (err) {
            console.error('❌ Erro ao carregar do Supabase:', err);
        }
    }

    // Fallback para memória
    if (salasData.has(sala)) {
        return salasData.get(sala).dados;
    }
    return [];
}

// ============================================
// SOCKET.IO EVENTOS
// ============================================
io.on('connection', (socket) => {
    console.log(`🟢 Cliente conectado: ${socket.id}`);

    // Obter sala e role da query
    const sala = socket.handshake.query.sala || 'default';
    const role = socket.handshake.query.role || 'cliente';

    // Entrar na sala
    socket.join(sala);
    console.log(`📌 Cliente ${socket.id} entrou na sala "${sala}" como ${role}`);

    // Inicializar dados da sala se não existir
    if (!salasData.has(sala)) {
        salasData.set(sala, { dados: [], clientes: [] });
    }
    salasData.get(sala).clientes.push(socket.id);

    // Enviar dados atuais para o cliente
    (async () => {
        const dados = await carregarDadosSala(sala);
        socket.emit('db_update', dados);
        console.log(`📤 Enviados ${dados.length} imóveis para ${socket.id}`);
    })();

    // Cliente solicita dados
    socket.on('request_db', async (data) => {
        const salaReq = data.sala || sala;
        const dados = await carregarDadosSala(salaReq);
        socket.emit('db_update', dados);
        console.log(`📤 Cliente ${socket.id} solicitou dados da sala "${salaReq}"`);
    });

    // Admin sincroniza dados
    socket.on('sync_db', async (data) => {
        const salaSync = data.sala || sala;
        const novosDados = data.data || [];

        if (role === 'admin') {
            // Salvar dados
            await salvarDadosSala(salaSync, novosDados);
            
            // Atualizar cache
            if (!salasData.has(salaSync)) {
                salasData.set(salaSync, { dados: [], clientes: [] });
            }
            salasData.get(salaSync).dados = novosDados;

            // Notificar todos na sala (exceto o remetente)
            socket.to(salaSync).emit('db_update', novosDados);
            console.log(`📤 Admin ${socket.id} sincronizou ${novosDados.length} imóveis na sala "${salaSync}"`);
        } else {
            console.log(`⚠️ Cliente ${socket.id} tentou sincronizar dados (sem permissão)`);
            socket.emit('error', { message: 'Apenas admin pode sincronizar dados' });
        }
    });

    // Chat
    socket.on('chat_message', (data) => {
        const salaChat = data.sala || sala;
        const msg = data.msg || '';
        if (msg.trim()) {
            io.to(salaChat).emit('chat_message', msg);
            console.log(`💬 Mensagem na sala "${salaChat}": ${msg.substring(0, 30)}...`);
        }
    });

    // Desconexão
    socket.on('disconnect', () => {
        // Remover cliente da sala
        if (salasData.has(sala)) {
            const index = salasData.get(sala).clientes.indexOf(socket.id);
            if (index !== -1) {
                salasData.get(sala).clientes.splice(index, 1);
            }
        }
        console.log(`🔴 Cliente ${socket.id} desconectado da sala "${sala}"`);
    });

    // Erro
    socket.on('error', (err) => {
        console.error(`❌ Erro no socket ${socket.id}:`, err);
    });
});

// ============================================
// ROTAS HTTP
// ============================================
// Status do servidor
app.get('/status', (req, res) => {
    res.json({
        status: 'online',
        salas: Array.from(salasData.keys()),
        totalSalas: salasData.size,
        totalClientes: Array.from(salasData.values()).reduce((acc, s) => acc + s.clientes.length, 0),
        timestamp: new Date().toISOString()
    });
});

// Listar salas
app.get('/salas', (req, res) => {
    const salasInfo = [];
    for (const [nome, dados] of salasData) {
        salasInfo.push({
            nome,
            imoveis: dados.dados.length,
            clientes: dados.clientes.length
        });
    }
    res.json(salasInfo);
});

// Dados de uma sala específica
app.get('/sala/:nome', async (req, res) => {
    const nome = req.params.nome;
    const dados = await carregarDadosSala(nome);
    res.json({
        sala: nome,
        imoveis: dados,
        total: dados.length
    });
});

// Rota principal (servir HTML)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/manager.html');
});

// ============================================
// INICIAR SERVIDOR
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando em http://localhost:${PORT}`);
    console.log(`📡 Socket.IO disponível em ws://localhost:${PORT}`);
    console.log(`🌐 Acesse: http://localhost:${PORT}/manager.html?sala=teste2`);
    console.log(`📊 Status: http://localhost:${PORT}/status`);
    console.log(`📋 Salas: http://localhost:${PORT}/salas`);
});

// ============================================
// TRATAMENTO DE ERROS
// ============================================
process.on('uncaughtException', (err) => {
    console.error('❌ Erro não tratado:', err);
});

process.on('SIGINT', () => {
    console.log('🛑 Servidor finalizado');
    process.exit(0);
});
