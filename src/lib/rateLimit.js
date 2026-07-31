// rateLimit.js
// Prevents brute-force / abuse on the endpoints where it matters most.
// Each limiter tracks requests per IP address within a rolling time
// window; once the limit is hit, further requests get a 429 until the
// window resets — the request never reaches the real route handler.

const rateLimit = require("express-rate-limit");

function makeLimiter({ windowMs, max, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true, // adds RateLimit-* response headers
    legacyHeaders: false,
    message: { error: message },
    handler: (req, res, _next, options) => {
      res.status(429).json(options.message);
    }
  });
}

// Login: the classic brute-force target. 10 attempts per 15 minutes per
// IP is generous for a real user who mistypes their password a few
// times, but stops automated password-guessing dead.
const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: "Too many login attempts. Please wait 15 minutes and try again."
});

// Forgot-password: without a limit here, someone could spam a real
// user's inbox with reset emails, or (if Resend billing were usage-based)
// run up a cost. 5 requests per 15 minutes per IP is plenty for legitimate use.
const forgotPasswordLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: "Too many password reset requests. Please wait 15 minutes and try again."
});

// Signup: prevents scripted mass account creation.
const registerLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: "Too many signup attempts from this network. Please try again later."
});

module.exports = { loginLimiter, forgotPasswordLimiter, registerLimiter };
