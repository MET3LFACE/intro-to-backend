const jwt = require('jsonwebtoken');

module.exports = function requireAuth(req, res, next) {
    const [scheme, token] =(req.headers.authorization || '').split(' ');
    if (scheme !== 'Bearer'  || !token) return res.status(401).json({error: 'Missing token.'});
    try{
        req.user = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({error: 'Invalid or expired token.'});
    }
};