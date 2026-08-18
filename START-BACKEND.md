# Starting ACTIV Backend Server

## Prerequisites
- Node.js installed
- MongoDB Atlas connection configured in `.env` file

## Starting the Backend

### Option 1: Production Mode
```powershell
cd C:\activfinal\activ-project-new\activ-backend
node src/server.js
```

### Option 2: Development Mode (with auto-restart)
```powershell
cd C:\activfinal\activ-project-new\activ-backend
npm run dev
```

## Verify Backend is Running

You should see:
```
╔═══════════════════════════════════════╗
║   ACTIV Backend Server Started   ║
╠═══════════════════════════════════════╣
║ Environment: development            ║
║ Port: 5000                          ║
║ API Version: v1                      ║
║ MongoDB: Connected                    ║
║ Redis: Connected                    ║
╚═══════════════════════════════════════╝
```

## API Endpoints
- Base URL: `http://localhost:5000`
- API Version: `v1`
- Health Check: `http://localhost:5000/api/v1/health`

## Test Backend Connection
```powershell
cd C:\activfinal\activ-project-new\activ-backend
node check-db.js
```

## Important Notes
- Keep this terminal window open while using the app
- Backend must be running before starting the frontend
- MongoDB Atlas connection is required
