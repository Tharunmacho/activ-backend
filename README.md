# ACTIV Backend API

Node.js/Express backend for ACTIV membership platform with MongoDB and Redis.

## Features

- ✅ JWT Authentication & Authorization
- ✅ Role-based Access Control (RBAC)
- ✅ Redis Caching with Memory Fallback
- ✅ Rate Limiting
- ✅ Input Validation
- ✅ Error Handling
- ✅ Request Logging
- ✅ Security Middleware (Helmet, CORS)
- ✅ Performance Monitoring
- ✅ PM2 Clustering

## Architecture

```
src/
├── config/           # Configuration files
├── core/             # Core utilities & middleware
├── modules/          # Feature modules
│   ├── auth/
│   ├── members/
│   ├── applications/
│   ├── admin/
│   ├── notifications/
│   └── analytics/
├── routes.js         # Main routes
├── app.js            # Express app
└── server.js         # HTTP server
```

## Installation

```bash
npm install
```

## Environment Setup

Copy `.env` and configure:

```env
NODE_ENV=development
PORT=5000
MONGODB_URI=mongodb://localhost:27017/activ-db
REDIS_HOST=localhost
REDIS_PORT=6379
JWT_SECRET=your-secret-key
```

## Running

### Development
```bash
npm run dev
```

### Production
```bash
npm start
```

### With PM2
```bash
npm run pm2:start
npm run pm2:logs
npm run pm2:stop
```

## API Endpoints

### Auth (`/api/v1/auth`)
- `POST /register` - Register user
- `POST /login` - Login
- `POST /refresh` - Refresh token
- `POST /logout` - Logout
- `GET /me` - Get current user
- `POST /change-password` - Change password

### Members (`/api/v1/members`)
- `GET /my-profile` - Get my profile
- `PUT /profile` - Update profile
- `GET /` - List members

### Applications (`/api/v1/applications`)
- `POST /` - Submit application
- `GET /my-applications` - Get my applications
- `GET /:id` - Get application
- `PATCH /:id/status` - Update status (Admin)

### Admin (`/api/v1/admin`)
- `GET /stats` - Dashboard stats
- `GET /users` - List users
- `PATCH /users/:id/role` - Update role
- `PATCH /users/:id/toggle-status` - Toggle status

### Notifications (`/api/v1/notifications`)
- `GET /` - List notifications
- `PATCH /:id/read` - Mark as read
- `PATCH /read-all` - Mark all as read

### Analytics (`/api/v1/analytics`)
- `GET /user-growth` - User growth stats
- `GET /applications` - Application stats
- `GET /members` - Member stats

## Testing

```bash
npm test
```

## License

ISC
