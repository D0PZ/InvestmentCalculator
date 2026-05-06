const express = require('express');
const router = express.Router();
const { isPasswordSet, setPassword, getStoredHash, verifyPassword } = require('../lib/auth');

router.get('/setup', (req, res) => {
  if (isPasswordSet()) return res.redirect('/login');
  res.render('setup', { title: 'Configurar acceso', error: null });
});

router.post('/setup', (req, res) => {
  if (isPasswordSet()) return res.redirect('/login');
  const { password, confirm } = req.body;
  if (!password || password.length < 8) {
    return res.render('setup', { title: 'Configurar acceso', error: 'Mínimo 8 caracteres' });
  }
  if (password !== confirm) {
    return res.render('setup', { title: 'Configurar acceso', error: 'Las contraseñas no coinciden' });
  }
  setPassword(password);
  req.session.authed = true;
  res.redirect('/');
});

router.get('/login', (req, res) => {
  if (!isPasswordSet()) return res.redirect('/setup');
  res.render('login', { title: 'Login', error: null });
});

router.post('/login', (req, res) => {
  const { password } = req.body;
  if (verifyPassword(password, getStoredHash())) {
    req.session.authed = true;
    return res.redirect('/');
  }
  res.render('login', { title: 'Login', error: 'Contraseña incorrecta' });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

module.exports = router;
