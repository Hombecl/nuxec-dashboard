// Vercel Serverless Function - n8n Webhook Trigger Proxy
// This proxies webhook triggers to n8n.nuxec.com

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const N8N_WEBHOOK_BASE = 'https://n8n.nuxec.com/webhook';

    // Get the webhook path from query parameter
    const { path } = req.query;

    if (!path) {
        return res.status(400).json({ error: 'Missing webhook path parameter' });
    }

    const url = `${N8N_WEBHOOK_BASE}/${path}`;

    try {
        const fetchOptions = {
            method: req.method,
            headers: {
                'Content-Type': 'application/json',
            },
        };

        // Add body for POST requests
        if (req.method === 'POST' && req.body) {
            fetchOptions.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, fetchOptions);

        // Try to parse as JSON, fallback to text
        const contentType = response.headers.get('content-type');
        let data;

        if (contentType && contentType.includes('application/json')) {
            data = await response.json();
        } else {
            data = { message: await response.text() };
        }

        return res.status(response.status).json(data);
    } catch (error) {
        console.error('Webhook trigger error:', error);
        return res.status(500).json({ error: error.message });
    }
}
