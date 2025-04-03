import {WebSocket, WebSocketServer } from "ws"
import jwt, { JwtPayload } from "jsonwebtoken"
const wss = new WebSocketServer({port:8080})
import { JWT_SECRET } from "./config"
import { prismaClient } from "./db"
import { v2 as cloudinary } from "cloudinary"
import axios from "axios"

interface Users {
    rooms: string[],  // Changed String to string for TypeScript standard
    userId: string,   // Changed String to string
    ws: WebSocket,
    name: string
}

const users : Users[] = []

cloudinary.config({
    cloud_name: 'dyxsai3xf',
    api_key: '247246481321692',
    api_secret: 'FWr9b-GToAKYxT5Hs36Fumz7sKQ'
  });


  const url = `https://draw-ws-backend.onrender.com`;
  const interval = 30000;
  
  function reloadWebsite() {
    axios
      .get(url)
      .then((response) => {
        console.log("website reloded");
      })
      .catch((error) => {
        console.error(`Error : ${error.message}`);
      });
  }
  
  setInterval(reloadWebsite, interval);

wss.on("connection",(ws,request)=>{
    const url = request.url
    if (!url) {  // Added check for undefined URL
        ws.close();
        return;
    }
    const urlPramas = new URLSearchParams(url.split("?")[1])
    const token = urlPramas.get("token") || ""
    
    try {  // Added try/catch for JWT verification
        const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload
        
        if(!decoded || !decoded.id || !decoded.email || !decoded.name){  // Added check for required fields
            ws.close()
            return
        }
        
        users.push({
            rooms: [],
            userId: decoded.id,
            ws: ws,
            name: decoded.name
        })
        
        const broadcastUsers = (roomId: string) => {
            const roomUsers = users
                .filter(user => user.rooms.includes(roomId))
                .map(user => ({
                    userId: user.userId,
                    name: user.name
                }));
            
            users.forEach(user => {
                if (user.rooms.includes(roomId)) {
                    user.ws.send(JSON.stringify({
                        type: "users_update",
                        users: roomUsers
                    }));
                }
            });
        };
        
        ws.on("error",(error)=>console.log(error))
        
        ws.on("message",async (data)=>{  // Fixed data type handling
            try {  // Added try/catch for JSON parsing
                const parsedData = JSON.parse(data.toString())
                
                if (parsedData.type === "join_room") {
                    const user = users.find(user => user.ws === ws);
                    if (user && !user.rooms.includes(parsedData.roomId)) {  // Prevent duplicate room entries
                        user.rooms.push(parsedData.roomId);
                        broadcastUsers(parsedData.roomId);
                    }
                }
                else if (parsedData.type === "leave_room") {
                    const user = users.find(user => user.ws === ws);
                    if (!user) return;
                    user.rooms = user.rooms.filter(room => room !== parsedData.roomId);
                    broadcastUsers(parsedData.roomId);
                }
                else if(parsedData.type === "chat"){
                    // Validate required fields
                    if (!parsedData.roomId || !parsedData.message || !parsedData.userId) {
                        return;
                    }
                    
                    users.forEach(user=>{
                        if(user.rooms.includes(parsedData.roomId)){
                            user.ws.send(JSON.stringify({
                                type: "chat",
                                message: parsedData.message,
                                userId: parsedData.userId
                            }))
                        }
                    })
                    
                    await prismaClient.chat.create({
                        data:{
                            roomId: parseInt(parsedData.roomId),
                            message: parsedData.message,
                            userId: parsedData.userId
                        }
                    })
                }
                else if(parsedData.type === "delete_chat"){
                    // Validate required fields
                    if (!parsedData.roomId || !parsedData.message || !parsedData.userId) {
                        return;
                    }
                    
                    users.forEach(user=>{
                        if(user.rooms.includes(parsedData.roomId)){
                            user.ws.send(JSON.stringify({
                                type: "delete_chat",
                                message: parsedData.message,
                                userId: parsedData.userId
                            }))
                        }
                    })

                    await prismaClient.chat.deleteMany({
                        where:{
                            roomId: parseInt(parsedData.roomId),
                            message: parsedData.message,
                            userId: parsedData.userId
                        }
                    })
                }
                else if(parsedData.type === "text_chat"){
                    // Validate required fields
                    if (!parsedData.roomId || !parsedData.message || !parsedData.userId || !parsedData.name) {
                        return;
                    }
                    
                    users.forEach(user=>{
                        if(user.rooms.includes(parsedData.roomId)){
                            user.ws.send(JSON.stringify({
                                type: "text_chat",
                                message: parsedData.message,
                                userId: parsedData.userId,
                                user: {name: parsedData.name}
                            }))
                        }
                    })

                    await prismaClient.text_Chat.create({
                        data:{
                            roomId: parseInt(parsedData.roomId),
                            message: parsedData.message,
                            userId: parsedData.userId
                        }
                    })
                }
                else if(parsedData.type === "image_element") {
                    // Validate required fields
                    if (!parsedData.roomId || !parsedData.message || !parsedData.userId) {
                        return;
                    }
                    
                    try {
                        const message = JSON.parse(parsedData.message);
                        if (!message.src) {
                            return;
                        }
                        
                        const uploadResponse = await cloudinary.uploader.upload(message.src, {
                            folder: 'chat_images',
                        });
                        message.src = uploadResponse.secure_url;
                        const updatedMessage = JSON.stringify(message);
                        
                        users.forEach(user => {
                            if(user.rooms.includes(parsedData.roomId)) {
                                user.ws.send(JSON.stringify({
                                    type: "image_element",
                                    message: updatedMessage,
                                    userId: parsedData.userId,
                                    user: {name: parsedData.name}
                                }))
                            }
                        });
                        
                        await prismaClient.chat.create({
                            data: {
                                roomId: parseInt(parsedData.roomId),
                                message: updatedMessage,
                                userId: parsedData.userId
                            }
                        });
                    } catch (error) {
                        console.error('Error handling image upload:', error);
                    }
                }
            } catch (error) {
                console.error('Error parsing message data:', error);
            }
        })

        ws.on("close", () => {
            const userIndex = users.findIndex(user => user.ws === ws);
            if (userIndex === -1) return;
            if(!users[userIndex]) return
            // Make a copy of the user's rooms before removing them
            const userRooms = [...users[userIndex].rooms];
            
            // Remove the user
            users.splice(userIndex, 1);
            
            // Broadcast updated user list to all rooms the user was in
            userRooms.forEach(roomId => {
                broadcastUsers(roomId);
            });
        });
        
    } catch (error) {
        console.error('Error verifying token:', error);
        ws.close();
    }
})