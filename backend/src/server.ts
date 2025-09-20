/**
 * TF-Planner 백엔드 메인 서버 파일
 * Express.js 기반의 REST API 서버
 * Socket.IO를 통한 실시간 채팅 기능 제공
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';

// 라우트 임포트
import authRoutes from './routes/authRoutes';
import chatRoutes from './routes/chatRoutes';
import taskRoutes from './routes/taskRoutes';

// 미들웨어 임포트
import { errorHandler } from './middleware/errorHandler';
import { logger } from './utils/logger';

// 환경 변수 로드
dotenv.config();

// Express 앱 생성
const app = express();
const server = createServer(app);

// Socket.IO 서버 설정
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
    credentials: true
  }
});

// 포트 설정
const PORT = process.env.PORT || 3001;

// 요청 제한 설정 (DDoS 방지)
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15분
  max: 100, // 최대 100개 요청
  message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.'
});

// 미들웨어 설정
app.use(helmet()); // 보안 헤더 설정
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true
}));
app.use(limiter); // 요청 제한
app.use(express.json({ limit: '10mb' })); // JSON 파싱 (파일 업로드 고려)
app.use(express.urlencoded({ extended: true }));

// 로깅 미들웨어
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path} - ${req.ip}`);
  next();
});

// API 라우트 설정
app.use('/api/auth', authRoutes); // 인증 관련 API
app.use('/api/chat', chatRoutes); // 채팅 관련 API
app.use('/api/tasks', taskRoutes); // 작업 관리 API

// 헬스 체크 엔드포인트
app.get('/api/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

const userSocketMap: { [userId: string]: string[] } = {};

// roomId에서 참여자 ID 목록을 추출하는 헬퍼 함수
const getParticipantsFromRoomId = (roomId: string): string[] => {
  if (roomId.startsWith('dm_')) {
    return roomId.split('_').slice(1);
  }
  // TODO: 그룹 채팅방의 경우, 참여자 목록을 별도의 저장소에서 조회해야 함
  // 현재 구현에서는 1:1 채팅만 완벽하게 지원
  return [];
};

io.on('connection', (socket) => {
  logger.info(`사용자 연결됨: ${socket.id}`);

  // 1. 사용자 등록 (user-join 이벤트 처리)
  socket.on('user-join', (data: { id: string }) => {
    const userId = data.id;
    if (!userId) return;

    if (!userSocketMap[userId]) {
      userSocketMap[userId] = [];
    }
    userSocketMap[userId].push(socket.id);
    logger.info(`사용자 등록: ${userId} -> 소켓 ${socket.id}`);
    logger.info(`현재 접속자 맵: ${JSON.stringify(userSocketMap)}`);
  });

  // 채팅방 참가 (기존 로직 유지, UI상태 표시에 필요할 수 있음)
  socket.on('join-room', (roomId: string) => {
    socket.join(roomId);
    logger.info(`사용자 ${socket.id}가 방 ${roomId}에 참가했습니다.`);
  });

  // 채팅방 나가기 (기존 로직 유지)
  socket.on('leave-room', (roomId: string) => {
    socket.leave(roomId);
    logger.info(`사용자 ${socket.id}가 방 ${roomId}에서 나갔습니다.`);
  });

  // 2. 메시지 전송 로직 수정
  socket.on('send-message', (data) => {
    const message = {
      id: Date.now().toString(),
      content: data.content,
      senderId: data.senderId,
      senderName: data.senderName,
      timestamp: new Date().toISOString(),
      type: data.type || 'text',
      fileUrl: data.fileUrl,
      fileName: data.fileName
    };

    const roomId = data.roomId;
    let participants: string[] = [];

    // 클라이언트가 참여자 목록을 보내줬는지 확인 (그룹 채팅)
    if (data.participants && data.participants.length > 0) {
      participants = data.participants;
    } else {
      // 참여자 목록이 없으면 DM 방 ID에서 파싱 (1:1 채팅)
      participants = getParticipantsFromRoomId(roomId);
    }

    if (participants.length > 0) {
      logger.info(`메시지 전송 -> 방: ${roomId}, 참여자: ${participants.join(', ')}`);
      participants.forEach(userId => {
        const userSockets = userSocketMap[userId];
        if (userSockets && userSockets.length > 0) {
          userSockets.forEach(socketId => {
            // 모든 참여자에게 메시지 자체를 전송
            io.to(socketId).emit('receive-message', {
              roomId: roomId,
              message: message
            });

            // 발신자를 제외한 모든 참여자에게 "알림"을 전송
            if (userId !== message.senderId) {
              io.to(socketId).emit('new-message-notification', {
                roomId: roomId,
                senderName: message.senderName,
                message: message
              });
            }
          });
        }
      });
    } else {
      // 참여자를 특정할 수 없는 경우 (예: 공지방), 기존의 방 기반 브로드캐스트 사용
      logger.info(`(폴백) 메시지 전송 -> 방: ${roomId}`);
      io.to(roomId).emit('receive-message', { 
        roomId: roomId, 
        message: message 
      });
    }
  });

  // 3. 연결 해제 시 사용자 정보 제거
  socket.on('disconnect', () => {
    let disconnectedUserId: string | null = null;
    for (const userId in userSocketMap) {
      const socketIds = userSocketMap[userId];
      const index = socketIds.indexOf(socket.id);
      if (index !== -1) {
        socketIds.splice(index, 1);
        if (socketIds.length === 0) {
          delete userSocketMap[userId];
        }
        disconnectedUserId = userId;
        break;
      }
    }
    logger.info(`사용자 연결 해제됨: ${socket.id} (ID: ${disconnectedUserId || 'N/A'})`);
    logger.info(`현재 접속자 맵: ${JSON.stringify(userSocketMap)}`);
  });
});

// 에러 핸들링 미들웨어 (마지막에 위치)
app.use(errorHandler);

// 서버 시작
server.listen(PORT, () => {
  logger.info(`🚀 TF-Planner 백엔드 서버가 포트 ${PORT}에서 실행 중입니다.`);
  logger.info(`📱 프론트엔드 URL: ${process.env.FRONTEND_URL || "http://localhost:5173"}`);
});

export default app;