// Stasis Signaling Server - Facilitates pairing between phone and PC
// Deploy to Render.com, Railway.app, or Fly.io for free

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// In-memory storage for pairing sessions (resets on server restart)
// Format: { code: { phoneRegistered: timestamp, pcIp: string, pcPort: number, pcRegistered: timestamp } }
const pairingSessions = new Map();

// Cleanup old sessions every 5 minutes
setInterval(() => {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    
    for (const [code, data] of pairingSessions.entries()) {
        const oldestTimestamp = Math.min(
            data.phoneRegistered || now,
            data.pcRegistered || now
        );
        
        if (now - oldestTimestamp > fiveMinutes) {
            pairingSessions.delete(code);
            console.log(`Cleaned up expired session: ${code}`);
        }
    }
}, 5 * 60 * 1000);

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        service: 'Stasis Signaling Server',
        status: 'running',
        activeSessions: pairingSessions.size,
        uptime: process.uptime()
    });
});

// Phone registers with a 6-digit code
app.post('/register-phone', (req, res) => {
    const { code } = req.body;
    
    if (!code || typeof code !== 'string' || code.length !== 6) {
        return res.status(400).json({ error: 'Invalid code format' });
    }
    
    if (!pairingSessions.has(code)) {
        pairingSessions.set(code, {
            phoneRegistered: Date.now(),
            pcIp: null,
            pcPort: null,
            pcRegistered: null
        });
    } else {
        // Update timestamp if re-registering
        const session = pairingSessions.get(code);
        session.phoneRegistered = Date.now();
    }
    
    console.log(`Phone registered with code: ${code}`);
    res.json({ success: true, message: 'Phone registered' });
});

// PC registers with the code and provides its connection info
app.post('/register-pc', (req, res) => {
    const { code, pcIp, pcPort } = req.body;
    
    if (!code || !pcIp || !pcPort) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    
    if (typeof code !== 'string' || code.length !== 6) {
        return res.status(400).json({ error: 'Invalid code format' });
    }
    
    const session = pairingSessions.get(code);
    
    if (!session) {
        return res.status(404).json({ error: 'Code not found. Generate a new code on phone.' });
    }
    
    // Update PC connection info
    session.pcIp = pcIp;
    session.pcPort = pcPort;
    session.pcRegistered = Date.now();
    
    console.log(`PC registered for code ${code}: ${pcIp}:${pcPort}`);
    res.json({ success: true, message: 'PC registered and paired' });
});

// Phone polls this to get PC connection info
app.get('/check-connection', (req, res) => {
    const { code } = req.query;
    
    if (!code || typeof code !== 'string' || code.length !== 6) {
        return res.status(400).json({ error: 'Invalid code' });
    }
    
    const session = pairingSessions.get(code);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    if (session.pcIp && session.pcPort) {
        // PC has registered, return connection info
        console.log(`Connection info retrieved for code ${code}`);
        res.json({
            pcIp: session.pcIp,
            pcPort: session.pcPort,
            paired: true
        });
    } else {
        // PC hasn't registered yet
        res.json({ paired: false });
    }
});

// Get session info (for debugging)
app.get('/session/:code', (req, res) => {
    const { code } = req.params;
    const session = pairingSessions.get(code);
    
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    res.json({
        code,
        phoneRegistered: session.phoneRegistered,
        pcRegistered: session.pcRegistered,
        hasPcInfo: !!(session.pcIp && session.pcPort),
        age: Date.now() - (session.phoneRegistered || session.pcRegistered)
    });
});

// Delete a session (cleanup endpoint)
app.delete('/session/:code', (req, res) => {
    const { code } = req.params;
    
    if (pairingSessions.delete(code)) {
        res.json({ success: true, message: 'Session deleted' });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Stasis Signaling Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});