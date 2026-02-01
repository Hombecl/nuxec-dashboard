// Vercel Serverless Function - n8n API Proxy
// This proxies requests to n8n.nuxec.com to avoid CORS issues

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const N8N_API_KEY = process.env.N8N_API_KEY;
    const N8N_BASE_URL = 'https://n8n.nuxec.com/api/v1';

    if (!N8N_API_KEY) {
        return res.status(500).json({ error: 'N8N_API_KEY not configured' });
    }

    // Get the path from query parameter
    const { path, ...queryParams } = req.query;

    if (!path) {
        return res.status(400).json({ error: 'Missing path parameter' });
    }

    // Build query string from remaining params
    const queryString = Object.keys(queryParams).length > 0
        ? '?' + new URLSearchParams(queryParams).toString()
        : '';

    const url = `${N8N_BASE_URL}/${path}${queryString}`;

    try {
        const fetchOptions = {
            method: req.method,
            headers: {
                'X-N8N-API-KEY': N8N_API_KEY,
                'Content-Type': 'application/json',
            },
        };

        // Add body for POST/PUT requests
        if (req.method === 'POST' || req.method === 'PUT') {
            fetchOptions.body = JSON.stringify(req.body);
        }

        const response = await fetch(url, fetchOptions);
        const data = await response.json();

        return res.status(response.status).json(data);
    } catch (error) {
        console.error('n8n API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
