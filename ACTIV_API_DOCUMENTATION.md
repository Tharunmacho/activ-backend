# ACTIV Platform - Complete API Documentation

## Overview

This document provides comprehensive API documentation for the ACTIV platform backend, including all endpoints, request/response formats, authentication requirements, and frontend integration guide.

**Base URL:** `http://localhost:5000/api`

**Databases:**
- **membersdb**: memberauths, memberdetails, memberbusinessinfos, memberfinancialinfos, memberdeclarations, applications, products, activities, connections, notifications
- **adminsdb**: blockadmins, districtadmins, stateadmins, superadmins

---

## Authentication

All authenticated endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <token>
```

### Token Structure
```json
{
  "userId": "ObjectId",
  "email": "user@example.com",
  "role": "member|block_admin|district_admin|state_admin|super_admin",
  "iat": 1234567890,
  "exp": 1234567890
}
```

---

## 1. Authentication API

### 1.1 Register Member

**Endpoint:** `POST /api/auth/register`

**Description:** Register a new member account

**Request Body:**
```json
{
  "email": "member@example.com",
  "password": "SecurePassword123!",
  "fullName": "John Doe",
  "phoneNumber": "+919876543210",
  "state": "Karnataka",
  "district": "Bangalore Urban",
  "block": "Bangalore North"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "67567f5a8e3c4d001f8b4567",
      "email": "member@example.com",
      "isActive": true,
      "createdAt": "2025-12-09T10:30:00.000Z"
    },
    "memberDetails": {
      "_id": "67567f5a8e3c4d001f8b4568",
      "memberId": "67567f5a8e3c4d001f8b4567",
      "fullName": "John Doe",
      "email": "member@example.com",
      "phoneNumber": "+919876543210",
      "state": "Karnataka",
      "district": "Bangalore Urban",
      "block": "Bangalore North",
      "membershipStatus": "pending",
      "membershipType": "none",
      "profileCompleted": false
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "message": "Registration successful"
}
```

**Frontend Integration (React Native):**
```typescript
// src/services/api.ts
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const API_BASE_URL = 'http://localhost:5000/api';

export const registerMember = async (data: {
  email: string;
  password: string;
  fullName: string;
  phoneNumber: string;
  state: string;
  district: string;
  block: string;
}) => {
  try {
    const response = await axios.post(`${API_BASE_URL}/auth/register`, data);
    
    // Store token
    await AsyncStorage.setItem('authToken', response.data.data.token);
    await AsyncStorage.setItem('userId', response.data.data.user._id);
    
    return response.data;
  } catch (error) {
    throw error.response?.data || error;
  }
};
```

---

### 1.2 Login

**Endpoint:** `POST /api/auth/login`

**Description:** Login for members and admins

**Request Body:**
```json
{
  "email": "member@example.com",
  "password": "SecurePassword123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "_id": "67567f5a8e3c4d001f8b4567",
      "email": "member@example.com",
      "isActive": true,
      "lastLogin": "2025-12-09T10:35:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "role": "member"
  },
  "message": "Login successful"
}
```

**Frontend Integration:**
```typescript
export const login = async (email: string, password: string) => {
  const response = await axios.post(`${API_BASE_URL}/auth/login`, {
    email,
    password
  });
  
  await AsyncStorage.setItem('authToken', response.data.data.token);
  await AsyncStorage.setItem('userRole', response.data.data.role);
  
  return response.data;
};
```

---

### 1.3 Get Current User Profile

**Endpoint:** `GET /api/auth/me`

**Authentication:** Required

**Response (200):**
```json
{
  "success": true,
  "data": {
    "auth": {
      "_id": "67567f5a8e3c4d001f8b4567",
      "email": "member@example.com",
      "isActive": true
    },
    "details": {
      "fullName": "John Doe",
      "phoneNumber": "+919876543210",
      "state": "Karnataka",
      "district": "Bangalore Urban",
      "block": "Bangalore North",
      "membershipStatus": "active",
      "membershipType": "annual"
    }
  }
}
```

---

### 1.4 Admin Login

**Endpoint:** `POST /api/auth/admin/login`

**Description:** Login for Block/District/State/Super Admins

**Request Body:**
```json
{
  "adminId": "BA0001",
  "email": "blockadmin@activ.com",
  "password": "AdminPassword123!"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "admin": {
      "_id": "67567f5a8e3c4d001f8b4569",
      "adminId": "BA0001",
      "email": "blockadmin@activ.com",
      "fullName": "Block Admin 1",
      "role": "block_admin",
      "state": "Karnataka",
      "district": "Bangalore Urban",
      "block": "Bangalore North"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

---

## 2. Member Profile API

### 2.1 Get Member Profile

**Endpoint:** `GET /api/members/profile`

**Authentication:** Required (Member)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "auth": {
      "_id": "67567f5a8e3c4d001f8b4567",
      "email": "member@example.com"
    },
    "details": {
      "fullName": "John Doe",
      "phoneNumber": "+919876543210",
      "state": "Karnataka",
      "membershipStatus": "active"
    },
    "businessInfo": {
      "organizationName": "ABC Enterprises",
      "businessType": "Manufacturing",
      "status": "approved"
    },
    "financialInfo": {
      "gstNumber": "29ABCDE1234F1Z5",
      "turnoverRange": "50 Lakhs - 1 Crore"
    },
    "declaration": {
      "agreeToDeclaration": true,
      "status": "approved"
    }
  }
}
```

---

### 2.2 Update Member Details

**Endpoint:** `PUT /api/members/details`

**Authentication:** Required (Member)

**Request Body:**
```json
{
  "fullName": "John Doe Updated",
  "phoneNumber": "+919876543210",
  "city": "Bangalore",
  "educationalQualification": "Graduate",
  "religion": "Hindu",
  "socialCategory": "OBC"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "fullName": "John Doe Updated",
    "phoneNumber": "+919876543210",
    "city": "Bangalore",
    "educationalQualification": "Graduate",
    "profileCompleted": true
  },
  "message": "Profile updated successfully"
}
```

**Frontend Screen:** `MemberProfileScreen.tsx`

---

### 2.3 Update Business Information

**Endpoint:** `PUT /api/members/business-info`

**Authentication:** Required (Member)

**Request Body:**
```json
{
  "organizationName": "ABC Enterprises Pvt Ltd",
  "constitutionType": "Private Limited",
  "businessType": "Manufacturing",
  "businessActivities": ["Textiles", "Garments"],
  "numberOfEmployees": 50,
  "businessWebsite": "https://abcenterprise.com"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "organizationName": "ABC Enterprises Pvt Ltd",
    "businessType": "Manufacturing",
    "status": "submitted"
  }
}
```

**Frontend Screen:** `BusinessInfoScreen.tsx`

---

### 2.4 Update Financial Information

**Endpoint:** `PUT /api/members/financial-info`

**Authentication:** Required (Member)

**Request Body:**
```json
{
  "panNumber": "ABCDE1234F",
  "gstNumber": "29ABCDE1234F1Z5",
  "udyamNumber": "UDYAM-KA-01-1234567",
  "filedITR": true,
  "turnoverRange": "50 Lakhs - 1 Crore",
  "govtSchemeBenefit": false
}
```

**Frontend Screen:** `FinancialInfoScreen.tsx`

---

### 2.5 Submit Declaration

**Endpoint:** `PUT /api/members/declaration`

**Authentication:** Required (Member)

**Request Body:**
```json
{
  "sisterConcerns": true,
  "companyNames": ["XYZ Traders", "DEF Logistics"],
  "agreeToDeclaration": true
}
```

**Frontend Screen:** `DeclarationScreen.tsx`

---

## 3. Application API

### 3.1 Submit Membership Application

**Endpoint:** `POST /api/applications`

**Authentication:** Required (Member)

**Description:** Submit complete membership application (automatically assigned to Block Admin)

**Request Body:**
```json
{
  "fullName": "John Doe",
  "email": "member@example.com",
  "phone": "+919876543210",
  "state": "Karnataka",
  "district": "Bangalore Urban",
  "block": "Bangalore North",
  "data": {
    "businessDetails": {},
    "financialDetails": {},
    "declaration": {}
  },
  "documents": [
    {
      "name": "Aadhaar Card",
      "url": "https://storage.activ.com/docs/aadhaar.pdf",
      "type": "identity"
    }
  ]
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4570",
    "userId": "67567f5a8e3c4d001f8b4567",
    "fullName": "John Doe",
    "status": "Pending-Block",
    "assignedBlockAdmin": "67567f5a8e3c4d001f8b4569",
    "createdAt": "2025-12-09T10:40:00.000Z"
  },
  "message": "Application submitted successfully"
}
```

**Frontend Screen:** `ApplicationSubmissionScreen.tsx`

---

### 3.2 Get Member Applications

**Endpoint:** `GET /api/applications/my-applications`

**Authentication:** Required (Member)

**Query Parameters:**
- `status`: Filter by status (optional)
- `page`: Page number (default: 1)
- `limit`: Items per page (default: 10)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "applications": [
      {
        "_id": "67567f5a8e3c4d001f8b4570",
        "fullName": "John Doe",
        "status": "Pending-District",
        "createdAt": "2025-12-09T10:40:00.000Z",
        "blockApprovedAt": "2025-12-10T09:00:00.000Z"
      }
    ],
    "pagination": {
      "total": 1,
      "page": 1,
      "pages": 1
    }
  }
}
```

**Frontend Screen:** `MemberApplicationsScreen.tsx`

---

### 3.3 Get Application Details

**Endpoint:** `GET /api/applications/:applicationId`

**Authentication:** Required

**Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4570",
    "userId": "67567f5a8e3c4d001f8b4567",
    "fullName": "John Doe",
    "email": "member@example.com",
    "status": "Pending-District",
    "assignedBlockAdmin": {
      "_id": "67567f5a8e3c4d001f8b4569",
      "adminId": "BA0001",
      "fullName": "Block Admin 1"
    },
    "assignedDistrictAdmin": {
      "_id": "67567f5a8e3c4d001f8b4571",
      "adminId": "DA0001",
      "fullName": "District Admin 1"
    },
    "blockApprovedAt": "2025-12-10T09:00:00.000Z",
    "reviewedBy": {
      "blockAdmin": "67567f5a8e3c4d001f8b4569"
    },
    "documents": [
      {
        "name": "Aadhaar Card",
        "url": "https://storage.activ.com/docs/aadhaar.pdf",
        "type": "identity"
      }
    ],
    "notes": [
      {
        "adminId": "67567f5a8e3c4d001f8b4569",
        "adminType": "BlockAdmin",
        "note": "All documents verified",
        "createdAt": "2025-12-10T09:00:00.000Z"
      }
    ]
  }
}
```

---

## 4. Admin API

### 4.1 Block Admin - Get Pending Applications

**Endpoint:** `GET /api/admin/block/applications`

**Authentication:** Required (Block Admin)

**Query Parameters:**
- `status`: Filter by status (default: "Pending-Block")
- `page`: Page number
- `limit`: Items per page

**Response (200):**
```json
{
  "success": true,
  "data": {
    "applications": [
      {
        "_id": "67567f5a8e3c4d001f8b4570",
        "fullName": "John Doe",
        "email": "member@example.com",
        "phone": "+919876543210",
        "block": "Bangalore North",
        "status": "Pending-Block",
        "createdAt": "2025-12-09T10:40:00.000Z"
      }
    ],
    "stats": {
      "total": 15,
      "pending": 10,
      "approved": 5
    }
  }
}
```

**Frontend Screen:** `BlockAdminDashboardScreen.tsx`

---

### 4.2 Block Admin - Approve Application

**Endpoint:** `POST /api/admin/block/applications/:applicationId/approve`

**Authentication:** Required (Block Admin)

**Request Body:**
```json
{
  "note": "All documents verified and approved"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4570",
    "status": "Pending-District",
    "blockApprovedAt": "2025-12-10T09:00:00.000Z",
    "assignedDistrictAdmin": "67567f5a8e3c4d001f8b4571",
    "reviewedBy": {
      "blockAdmin": "67567f5a8e3c4d001f8b4569"
    }
  },
  "message": "Application approved and forwarded to District Admin"
}
```

**Frontend Screen:** `BlockAdminDashboardScreen.tsx`

---

### 4.3 Block Admin - Reject Application

**Endpoint:** `POST /api/admin/block/applications/:applicationId/reject`

**Authentication:** Required (Block Admin)

**Request Body:**
```json
{
  "rejectionReason": "Incomplete documentation"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4570",
    "status": "Rejected",
    "rejectionReason": "Incomplete documentation",
    "rejectedBy": {
      "adminId": "67567f5a8e3c4d001f8b4569",
      "adminType": "BlockAdmin",
      "rejectedAt": "2025-12-10T09:15:00.000Z"
    }
  },
  "message": "Application rejected"
}
```

---

### 4.4 District Admin - Get Pending Applications

**Endpoint:** `GET /api/admin/district/applications`

**Authentication:** Required (District Admin)

**Frontend Screen:** `DistrictAdminDashboardScreen.tsx`

---

### 4.5 District Admin - Approve Application

**Endpoint:** `POST /api/admin/district/applications/:applicationId/approve`

**Authentication:** Required (District Admin)

**Response:** Application status changes to "Pending-State", assigned to State Admin

---

### 4.6 State Admin - Get Pending Applications

**Endpoint:** `GET /api/admin/state/applications`

**Authentication:** Required (State Admin)

**Frontend Screen:** `StateAdminDashboardScreen.tsx`

---

### 4.7 State Admin - Final Approve Application

**Endpoint:** `POST /api/admin/state/applications/:applicationId/approve`

**Authentication:** Required (State Admin)

**Response:** Application status changes to "Approved", member gets activated

**Effect:** 
- Application status → "Approved"
- MemberDetails.membershipStatus → "active"
- MemberDetails.membershipType → "annual"
- MemberDetails.approvedBy → State Admin ID
- MemberDetails.approvedAt → Current timestamp

---

### 4.8 Super Admin - Dashboard Analytics

**Endpoint:** `GET /api/admin/super/analytics`

**Authentication:** Required (Super Admin)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "members": {
      "total": 1500,
      "active": 1200,
      "pending": 200,
      "expired": 100
    },
    "applications": {
      "total": 300,
      "pending": 50,
      "pendingBlock": 20,
      "pendingDistrict": 15,
      "pendingState": 15,
      "approved": 200,
      "rejected": 50
    },
    "admins": {
      "blockAdmins": 50,
      "districtAdmins": 20,
      "stateAdmins": 5
    },
    "recentActivity": []
  }
}
```

**Frontend Screen:** `SuperAdminDashboardScreen.tsx`

---

## 5. Products API

### 5.1 Create Product

**Endpoint:** `POST /api/products`

**Authentication:** Required (Member with active membership)

**Request Body:**
```json
{
  "name": "Cotton Fabric",
  "description": "High quality cotton fabric",
  "category": "Textiles",
  "price": 500,
  "priceUnit": "per_meter",
  "imageUrl": "https://storage.activ.com/products/cotton.jpg"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4580",
    "companyId": "67567f5a8e3c4d001f8b4567",
    "name": "Cotton Fabric",
    "category": "Textiles",
    "price": 500,
    "status": "active"
  }
}
```

**Frontend Screen:** `AddProductScreen.tsx`

---

### 5.2 Get All Products

**Endpoint:** `GET /api/products`

**Query Parameters:**
- `category`: Filter by category
- `search`: Text search
- `featured`: true/false
- `page`: Page number
- `limit`: Items per page

**Response (200):**
```json
{
  "success": true,
  "data": {
    "products": [
      {
        "_id": "67567f5a8e3c4d001f8b4580",
        "name": "Cotton Fabric",
        "category": "Textiles",
        "price": 500,
        "priceUnit": "per_meter",
        "imageUrl": "https://storage.activ.com/products/cotton.jpg",
        "companyId": {
          "fullName": "John Doe",
          "organizationName": "ABC Enterprises"
        }
      }
    ],
    "pagination": {
      "total": 100,
      "page": 1,
      "pages": 10
    }
  }
}
```

**Frontend Screen:** `ProductsScreen.tsx`, `HomeScreen.tsx`

---

### 5.3 Get My Products

**Endpoint:** `GET /api/products/my-products`

**Authentication:** Required (Member)

**Frontend Screen:** `MyProductsScreen.tsx`

---

### 5.4 Update Product

**Endpoint:** `PUT /api/products/:productId`

**Authentication:** Required (Product Owner)

---

### 5.5 Delete Product

**Endpoint:** `DELETE /api/products/:productId`

**Authentication:** Required (Product Owner)

---

## 6. Connections API

### 6.1 Send Connection Request

**Endpoint:** `POST /api/connections/request`

**Authentication:** Required (Member)

**Request Body:**
```json
{
  "recipientId": "67567f5a8e3c4d001f8b4590",
  "message": "I'd like to connect with you"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4591",
    "senderId": "67567f5a8e3c4d001f8b4567",
    "recipientId": "67567f5a8e3c4d001f8b4590",
    "status": "pending",
    "message": "I'd like to connect with you"
  }
}
```

**Frontend Screen:** `MemberProfileScreen.tsx`

---

### 6.2 Get Received Connection Requests

**Endpoint:** `GET /api/connections/received`

**Authentication:** Required (Member)

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "_id": "67567f5a8e3c4d001f8b4591",
      "senderId": {
        "_id": "67567f5a8e3c4d001f8b4567",
        "fullName": "John Doe",
        "organizationName": "ABC Enterprises"
      },
      "status": "pending",
      "message": "I'd like to connect with you",
      "createdAt": "2025-12-09T11:00:00.000Z"
    }
  ]
}
```

**Frontend Screen:** `ConnectionRequestsScreen.tsx`

---

### 6.3 Accept Connection Request

**Endpoint:** `POST /api/connections/:connectionId/accept`

**Authentication:** Required (Recipient)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "67567f5a8e3c4d001f8b4591",
    "status": "accepted",
    "acceptedAt": "2025-12-09T11:05:00.000Z"
  }
}
```

---

### 6.4 Get My Connections

**Endpoint:** `GET /api/connections/my-connections`

**Authentication:** Required (Member)

**Frontend Screen:** `MyConnectionsScreen.tsx`

---

## 7. Activities API

### 7.1 Get My Activities

**Endpoint:** `GET /api/activities/my-activities`

**Authentication:** Required (Member)

**Query Parameters:**
- `activityType`: Filter by type
- `page`: Page number
- `limit`: Items per page

**Response (200):**
```json
{
  "success": true,
  "data": {
    "activities": [
      {
        "_id": "67567f5a8e3c4d001f8b4595",
        "activityType": "application_approved",
        "description": "Your application has been approved",
        "createdAt": "2025-12-10T10:00:00.000Z"
      },
      {
        "_id": "67567f5a8e3c4d001f8b4596",
        "activityType": "product_created",
        "description": "Product 'Cotton Fabric' created",
        "entityType": "Product",
        "entityId": "67567f5a8e3c4d001f8b4580",
        "createdAt": "2025-12-09T12:00:00.000Z"
      }
    ]
  }
}
```

**Frontend Screen:** `ActivityFeedScreen.tsx`, `HomeScreen.tsx`

---

## 8. Notifications API

### 8.1 Get My Notifications

**Endpoint:** `GET /api/notifications`

**Authentication:** Required

**Response (200):**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "_id": "67567f5a8e3c4d001f8b4600",
        "userId": "67567f5a8e3c4d001f8b4567",
        "type": "application_approved",
        "title": "Application Approved",
        "message": "Your membership application has been approved",
        "isRead": false,
        "createdAt": "2025-12-10T10:00:00.000Z"
      }
    ],
    "unreadCount": 5
  }
}
```

**Frontend Screen:** `NotificationsScreen.tsx`

---

### 8.2 Mark Notification as Read

**Endpoint:** `PUT /api/notifications/:notificationId/read`

**Authentication:** Required

---

### 8.3 Mark All Notifications as Read

**Endpoint:** `PUT /api/notifications/mark-all-read`

**Authentication:** Required

---

## 9. Analytics API

### 9.1 Get Member Analytics

**Endpoint:** `GET /api/analytics/member`

**Authentication:** Required (Member)

**Response (200):**
```json
{
  "success": true,
  "data": {
    "profile": {
      "completionPercentage": 85,
      "missingFields": ["aadhaarNumber"]
    },
    "products": {
      "total": 10,
      "active": 8,
      "views": 250
    },
    "connections": {
      "total": 45,
      "pending": 5,
      "accepted": 40
    },
    "activities": {
      "thisMonth": 23
    }
  }
}
```

**Frontend Screen:** `MemberDashboardScreen.tsx`

---

## Error Responses

All error responses follow this format:

```json
{
  "success": false,
  "error": {
    "statusCode": 400,
    "message": "Error message",
    "errors": []
  }
}
```

**Common Status Codes:**
- `400`: Bad Request - Invalid input data
- `401`: Unauthorized - Missing or invalid token
- `403`: Forbidden - Insufficient permissions
- `404`: Not Found - Resource not found
- `409`: Conflict - Duplicate entry
- `500`: Internal Server Error

---

## Frontend-Backend Integration Map

### Authentication Screens
| Screen | API Endpoints |
|--------|--------------|
| `LoginScreen.tsx` | `POST /api/auth/login` |
| `RegisterScreen.tsx` | `POST /api/auth/register` |
| `AdminLoginScreen.tsx` | `POST /api/auth/admin/login` |

### Member Screens
| Screen | API Endpoints |
|--------|--------------|
| `HomeScreen.tsx` | `GET /api/auth/me`, `GET /api/products`, `GET /api/activities/my-activities` |
| `MemberProfileScreen.tsx` | `GET /api/members/profile`, `PUT /api/members/details` |
| `BusinessInfoScreen.tsx` | `GET /api/members/business-info`, `PUT /api/members/business-info` |
| `FinancialInfoScreen.tsx` | `GET /api/members/financial-info`, `PUT /api/members/financial-info` |
| `DeclarationScreen.tsx` | `GET /api/members/declaration`, `PUT /api/members/declaration` |
| `ApplicationSubmissionScreen.tsx` | `POST /api/applications` |
| `MemberApplicationsScreen.tsx` | `GET /api/applications/my-applications` |
| `ApplicationDetailScreen.tsx` | `GET /api/applications/:id` |

### Product Screens
| Screen | API Endpoints |
|--------|--------------|
| `ProductsScreen.tsx` | `GET /api/products` |
| `MyProductsScreen.tsx` | `GET /api/products/my-products` |
| `AddProductScreen.tsx` | `POST /api/products` |
| `EditProductScreen.tsx` | `PUT /api/products/:id` |
| `ProductDetailScreen.tsx` | `GET /api/products/:id` |

### Connection Screens
| Screen | API Endpoints |
|--------|--------------|
| `MyConnectionsScreen.tsx` | `GET /api/connections/my-connections` |
| `ConnectionRequestsScreen.tsx` | `GET /api/connections/received` |
| Send Connection Button | `POST /api/connections/request` |
| Accept/Reject Connection | `POST /api/connections/:id/accept`, `POST /api/connections/:id/reject` |

### Admin Screens
| Screen | API Endpoints |
|--------|--------------|
| `BlockAdminDashboardScreen.tsx` | `GET /api/admin/block/applications`, `POST /api/admin/block/applications/:id/approve`, `POST /api/admin/block/applications/:id/reject` |
| `DistrictAdminDashboardScreen.tsx` | `GET /api/admin/district/applications`, `POST /api/admin/district/applications/:id/approve`, `POST /api/admin/district/applications/:id/reject` |
| `StateAdminDashboardScreen.tsx` | `GET /api/admin/state/applications`, `POST /api/admin/state/applications/:id/approve`, `POST /api/admin/state/applications/:id/reject` |
| `SuperAdminDashboardScreen.tsx` | `GET /api/admin/super/analytics` |

### Other Screens
| Screen | API Endpoints |
|--------|--------------|
| `NotificationsScreen.tsx` | `GET /api/notifications`, `PUT /api/notifications/:id/read` |
| `ActivityFeedScreen.tsx` | `GET /api/activities/my-activities` |
| `AnalyticsScreen.tsx` | `GET /api/analytics/member` |

---

## API Request Examples

### Complete Registration Flow

```typescript
// Step 1: Register
const registerResponse = await axios.post('/api/auth/register', {
  email: "member@example.com",
  password: "SecurePass123!",
  fullName: "John Doe",
  phoneNumber: "+919876543210",
  state: "Karnataka",
  district: "Bangalore Urban",
  block: "Bangalore North"
});

// Store token
const token = registerResponse.data.data.token;

// Step 2: Complete Business Info
await axios.put('/api/members/business-info', {
  organizationName: "ABC Enterprises",
  businessType: "Manufacturing",
  businessActivities: ["Textiles"]
}, {
  headers: { Authorization: `Bearer ${token}` }
});

// Step 3: Complete Financial Info
await axios.put('/api/members/financial-info', {
  gstNumber: "29ABCDE1234F1Z5",
  turnoverRange: "50 Lakhs - 1 Crore"
}, {
  headers: { Authorization: `Bearer ${token}` }
});

// Step 4: Submit Declaration
await axios.put('/api/members/declaration', {
  sisterConcerns: false,
  agreeToDeclaration: true
}, {
  headers: { Authorization: `Bearer ${token}` }
});

// Step 5: Submit Application
await axios.post('/api/applications', {
  fullName: "John Doe",
  email: "member@example.com",
  phone: "+919876543210",
  state: "Karnataka",
  district: "Bangalore Urban",
  block: "Bangalore North"
}, {
  headers: { Authorization: `Bearer ${token}` }
});
```

---

## 3-Tier Approval Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Lifecycle                     │
└─────────────────────────────────────────────────────────────┘

1. PENDING
   ↓ (Auto-assigned to Block Admin based on location)
   
2. Pending-Block
   ↓ Block Admin Reviews
   ├─ Approve → Status: Pending-District (Auto-assigned to District Admin)
   └─ Reject → Status: Rejected
   
3. Pending-District
   ↓ District Admin Reviews
   ├─ Approve → Status: Pending-State (Auto-assigned to State Admin)
   └─ Reject → Status: Rejected
   
4. Pending-State
   ↓ State Admin Reviews
   ├─ Approve → Status: Approved
   │            MembershipStatus: active
   │            MembershipType: annual
   └─ Reject → Status: Rejected
```

---

## Rate Limiting

- **Authentication endpoints**: 5 requests per 15 minutes
- **General API endpoints**: 100 requests per 15 minutes
- **Admin endpoints**: 200 requests per 15 minutes

---

## Data Validation Rules

### Email
- Must be valid email format
- Lowercase only
- Max 255 characters

### Password
- Minimum 8 characters
- Must contain uppercase, lowercase, number, special character

### Phone Number
- Format: +91XXXXXXXXXX
- 10 digits after country code

### Admin ID Formats
- Block Admin: `BA0001` to `BA9999`
- District Admin: `DA0001` to `DA9999`
- State Admin: `SA0001` to `SA9999`
- Super Admin: `SUPER001` to `SUPER999`

---

## Testing with cURL

### Register
```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!@#",
    "fullName": "Test User",
    "phoneNumber": "+919876543210",
    "state": "Karnataka",
    "district": "Bangalore Urban",
    "block": "Bangalore North"
  }'
```

### Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Test123!@#"
  }'
```

### Get Profile (Authenticated)
```bash
curl -X GET http://localhost:5000/api/auth/me \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## Database Collections Schema Summary

### membersdb
1. **memberauths**: email, password, isActive, lastLogin
2. **memberdetails**: memberId, fullName, email, phoneNumber, state, district, block, city, aadhaarNumber, educationalQualification, religion, socialCategory, profileCompleted, approvedBy, membershipStatus, membershipType
3. **memberbusinessinfos**: memberId, organizationName, constitutionType, businessType, businessActivities, numberOfEmployees, status
4. **memberfinancialinfos**: memberId, panNumber, gstNumber, udyamNumber, filedITR, turnoverRange, govtSchemeBenefit
5. **memberdeclarations**: memberId, sisterConcerns, companyNames, agreeToDeclaration, status, reviewNotes
6. **applications**: userId, fullName, email, phone, state, district, block, status, assignedBlockAdmin, assignedDistrictAdmin, assignedStateAdmin, approval timestamps, reviewedBy
7. **products**: companyId, name, description, category, price, priceUnit, featured, imageUrl, status
8. **activities**: memberId, companyId, activityType, entityType, entityId, description
9. **connections**: senderId, recipientId, status, message
10. **notifications**: userId, type, title, message, isRead

### adminsdb
1. **blockadmins**: adminId (BA0001), email, passwordHash, fullName, role, state, district, block, active
2. **districtadmins**: adminId (DA0001), email, passwordHash, fullName, role, state, district, active
3. **stateadmins**: adminId (SA0001), email, passwordHash, fullName, role, state, active
4. **superadmins**: adminId (SUPER001), email, passwordHash, fullName, role, active

---

## Environment Configuration

```env
# MongoDB
MONGODB_URI=mongodb+srv://activapp2025_db_user:o6xFHfqzLXM6LUaa@cluster1.gf7usct.mongodb.net/activ-db?retryWrites=true&w=majority&appName=Cluster1

# JWT
JWT_SECRET=your-super-secret-jwt-key-change-in-production
JWT_EXPIRES_IN=7d

# Server
PORT=5000
NODE_ENV=development

# Redis (Disabled)
REDIS_ENABLED=false
```

---

## Status & Next Steps

✅ **Completed:**
- All database models created and aligned with existing schema
- Separate database connections for membersdb and adminsdb
- Complete API endpoint structure documented
- Frontend-Backend integration mapping
- 3-tier approval workflow implemented in models

⏳ **TODO:**
1. Update auth.service.js to work with separate memberauths and memberdetails
2. Update member.service.js to handle all 4 member-related collections
3. Update application.service.js with 3-tier approval logic
4. Create separate admin services (block, district, state, super)
5. Test all endpoints with existing database
6. Add file upload endpoints for documents
7. Implement real-time notifications with Socket.io (optional)

---

**Document Version:** 1.0  
**Last Updated:** December 9, 2025  
**Author:** ACTIV Backend Team
