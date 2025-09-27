const fs = require("fs").promises;
const path = require("path");
const db = require("../config/db");
const { bahmniService } = require("../services/bahmni.services");
const env = require("../config/env.js");
const { ApiResponse } = require("../utils/api-response.js");

class ApiError extends Error {
    constructor(statusCode, message) {
        super(message);
        this.statusCode = statusCode;
    }
}

const uploadToBahmni = async (req, res, next) => {
    try {
        const { documentId, mrnNumber } = req.body;

        // Validate input
        if (!documentId || !mrnNumber) {
            throw new ApiError(400, "Document ID and MRN number are required");
        }
        // Get document from database
        const document = await db.document.findUnique({
            where: { id: +documentId },
        });

        if (!document) {
            throw new ApiError(404, "Document not found");
        }

        if (!['approved', 'uploaded', 'rescanned_approved'].includes(document.status)) {
            throw new ApiError(400, "Only approved, uploaded or rescanned_approved documents can be uploaded");
        }

        // Read file content
        const baseDir = path.resolve(__dirname, "..");
        const filePath = path.join(baseDir, document.filePath);
        let fileContent;

        try {
            await fs.access(filePath); // Check if file exists
            const stats = await fs.stat(filePath);

            // Check file size (limit to 10MB for safety)
            const maxSize = 10 * 1024 * 1024; // 10MB
            if (stats.size > maxSize) {
                throw new ApiError(400, `File too large: ${(stats.size / (1024 * 1024)).toFixed(2)}MB. Maximum allowed: 10MB`);
            }

            fileContent = await fs.readFile(filePath);
        } catch (err) {
            if (err instanceof ApiError) throw err;
            throw new ApiError(404, "Document file not found on server");
        }

        // Get patient UUID first to ensure patient exists
        const patientUuid = await bahmniService.getPatientUuid(mrnNumber);
        const [visitTypeUuid, encounterTypeUuid] = await Promise.all([
            bahmniService.getVisitTypeId(env.bahmni.visitType || "OPD"),
            bahmniService.getEncounterTypeId("Patient Document")
        ]);

        // Prepare other required UUIDs in parallel
        const [providerUuid, locationUuid] = await Promise.all([
            bahmniService.getProviderUuid(patientUuid, encounterTypeUuid),
            bahmniService.getLocationUuidByName(env.bahmni.locationName || "Bahmni Clinic"),
        ]);

        // Determine visit to use
        let visitUuid = null;
        const isReplacement = !!document.bahmniUrl || document.status === 'uploaded';
        if (isReplacement) {
            if (document.visitUUid) {
                const visitCheck = await bahmniService.checkVisitExists(document.visitUUid);
                if (visitCheck.exists && !visitCheck.voided) {
                    visitUuid = document.visitUUid;
                }
            }
            if (!visitUuid) {
                const activeVisit = await bahmniService.getActiveVisit(patientUuid);
                if (activeVisit?.uuid) visitUuid = activeVisit.uuid;
            }
            if (!visitUuid) {
                visitUuid = await bahmniService.createVisit(
                    patientUuid,
                    env.bahmni.visitType || "OPD",
                    env.bahmni.locationName || "Bahmni Clinic"
                );
            }
        } else {
            visitUuid = await bahmniService.getOrCreateActiveVisit(
                patientUuid,
                env.bahmni.visitType || "OPD",
                env.bahmni.locationName || "Bahmni Clinic"
            );
        }

        // Prepare document data
        const fileName = document.fileName || path.basename(filePath);
        const ext = path.extname(filePath).substring(1).toLowerCase();
        const fileType = ext.match(/(jpg|jpeg|png|gif)$/) ? "image" : ext;

        const format = ext;
        const base64Content = fileContent.toString("base64");

        // Upload document to Bahmni
        const uploadResponse = await bahmniService.uploadDocument({
            content: base64Content,
            encounterTypeName: "Patient Document",
            visitUuid,
            format,
            patientUuid,
            fileType,
            fileName
        });

        if (!uploadResponse?.url) {
            throw new ApiError(500, "Failed to upload document to Bahmni");
        }

        // Get additional UUIDs needed for linking
        const testUUid = await bahmniService.getTestUuid();
        const { startDatetime } = await bahmniService.getVisitStartDateAndEndDate(visitUuid);
        const nowIso = new Date().toISOString();

        // Link document to patient (encounter inside visit)
        await bahmniService.linkDocumentToPatient({
            patientUuid,
            visitTypeUuid,
            visitStartDate: startDatetime,
            encounterTypeUuid,
            encounterDateTime: nowIso,
            providerUuid,
            visitUuid,
            locationUuid,
            documents: [
                {
                    testUuid: testUUid,
                    image: uploadResponse.url,
                    obsDateTime: nowIso,
                },
            ],
        });

        // Update document status only after everything succeeds
        await db.document.update({
            where: { id: +documentId },
            data: {
                status: "uploaded",
                visitUUid: visitUuid,
                bahmniUrl: uploadResponse.url,
                uploaderId: req.user.id,
                uploadedAt: new Date(),
            },
        });

        return ApiResponse(res, 200, {
            bahmniUrl: uploadResponse.url,
            documentId: +documentId,
            patientUuid,
            visitUuid
        }, "Document uploaded to bahmni successfully")

    } catch (error) {
        console.error("Bahmni upload error:", error);
        if (!(error instanceof ApiError)) {
            const statusCode = error.statusCode || 500;
            const message = error.message || "Internal server error";
            error = new ApiError(statusCode, message);
        }
        next(error);
    }
};

const getAllApprovedDocuments = async (req, res, next) => {
    try {


        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Get total count
        const total = await db.document.count({
            where: {
                status: {
                    in: ["approved", "rescanned_approved"],
                },
            },
        });


        const approvedDocuments = await db.document.findMany({
            where: {
                status: {
                    in: ["approved", "rescanned_approved"],
                },
            },
            include: {
                scanner: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                },
                approver: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                },
                uploader: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                }
            },
            skip,
            take: limit,
            orderBy: {
                scannedAt: 'desc'
            }
        });

        console.log(approvedDocuments)

        // Return empty array instead of 404 for better UX
        return ApiResponse(res, 200, {
            data: approvedDocuments,
            page,
            total,
            totalPages: Math.ceil(total / limit),
        },
            approvedDocuments.length > 0
                ? "Retrieved all approved documents"
                : "No approved documents found",
        );

    } catch (error) {
        console.error("Error retrieving approved documents:", error);
        const apiError = new ApiError(500, "Failed to retrieve approved documents");
        next(apiError);
    }
};

const getALlUploadedDocuments = async (req, res, next) => {
    try {


        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        // Get total count
        const total = await db.document.count({
            where: {
                status: 'uploaded',
                uploaderId: req.user.id
            },
        });


        const uploadedDocs = await db.document.findMany({
            where: {
                status: 'uploaded',
                uploaderId: req.user.id
            },
            include: {
                scanner: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                },
                approver: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                },
                uploader: {
                    include: {
                        department: true,
                        education: true,
                        profession: true,
                    }
                }
            },
            skip,
            take: limit,
            orderBy: {
                scannedAt: 'desc'
            }
        });


        // Return empty array instead of 404 for better UX
        return ApiResponse(res, 200, {
            data: uploadedDocs,
            page,
            total,
            totalPages: Math.ceil(total / limit),
        },
            uploadedDocs.length > 0
                ? "Retrieved all uploaded documents"
                : "No uploaded documents found",
        );

    } catch (error) {
        console.error("Error retrieving uploaded documents:", error);
        const apiError = new ApiError(500, "Failed to retrieve uploaded documents");
        next(apiError);
    }
}

// Self-check function to simulate uploads and replacements without hitting Bahmni APIs
async function testBahmniUploadLogic() {
    // Prepare test file
    const uploadsDir = path.resolve(__dirname, "..", "uploads");
    try { await fs.mkdir(uploadsDir, { recursive: true }); } catch {}
    const testFilePath = path.join("uploads", "test.pdf");
    const absoluteTestFilePath = path.join(path.resolve(__dirname, ".."), testFilePath);
    await fs.writeFile(absoluteTestFilePath, "TEST FILE CONTENT");

    // In-memory DB stubs to avoid real database usage
    const users = [];
    const documents = [];
    let docAutoId = 1;
    const originalDb = { user: db.user, document: db.document };
    db.user = {
        async findFirst() { return users[0] || null; },
        async create({ data }) { const user = { ...data, id: users.length + 1 }; users.push(user); return user; },
    };
    db.document = {
        async create({ data }) { const record = { ...data, id: docAutoId++, bahmniUrl: null, visitUUid: null, uploadedAt: null }; documents.push(record); return record; },
        async findUnique({ where: { id } }) { return documents.find(d => d.id === id) || null; },
        async update({ where: { id }, data }) { const idx = documents.findIndex(d => d.id === id); if (idx === -1) throw new Error('Doc not found'); documents[idx] = { ...documents[idx], ...data }; return documents[idx]; }
    };

    // Ensure a user exists
    let user = await db.user.findFirst();
    if (!user) {
        user = await db.user.create({
            data: {
                employeeId: 'EMP_TEST',
                fullName: 'Test User',
                email: `test_${Date.now()}@example.com`,
                password: 'hashed',
                roles: ['Uploader','ScannerClerk'],
            }
        });
    }

    // Create a document ready for upload
    const doc = await db.document.create({
        data: {
            scannerId: user.id,
            employeeId: 'EMP_TEST',
            fileName: 'test.pdf',
            filePath: testFilePath,
            patientMRN: 'TEST-MRN-123',
            status: 'approved',
        }
    });

    // Monkey-patch bahmniService to simulate external calls
    const visits = [];
    let lastLinked = null;
    const original = {
        getPatientUuid: bahmniService.getPatientUuid,
        getVisitTypeId: bahmniService.getVisitTypeId,
        getEncounterTypeId: bahmniService.getEncounterTypeId,
        getProviderUuid: bahmniService.getProviderUuid,
        getLocationUuidByName: bahmniService.getLocationUuidByName,
        getOrCreateActiveVisit: bahmniService.getOrCreateActiveVisit,
        getActiveVisit: bahmniService.getActiveVisit,
        createVisit: bahmniService.createVisit,
        checkVisitExists: bahmniService.checkVisitExists,
        getTestUuid: bahmniService.getTestUuid,
        getVisitStartDateAndEndDate: bahmniService.getVisitStartDateAndEndDate,
        uploadDocument: bahmniService.uploadDocument,
        linkDocumentToPatient: bahmniService.linkDocumentToPatient,
    };

    bahmniService.getPatientUuid = async () => 'patient-uuid-1';
    bahmniService.getVisitTypeId = async () => 'visit-type-uuid-1';
    bahmniService.getEncounterTypeId = async () => 'encounter-type-uuid-1';
    bahmniService.getProviderUuid = async () => 'provider-uuid-1';
    bahmniService.getLocationUuidByName = async () => 'location-uuid-1';
    bahmniService.getActiveVisit = async () => visits.find(v => v.active) || null;
    bahmniService.createVisit = async (patientUuid) => {
        const v = { uuid: `visit-${visits.length+1}`, patientUuid, startDatetime: new Date().toISOString(), stopDatetime: null, active: true, voided: false };
        visits.push(v);
        return v.uuid;
    };
    bahmniService.getOrCreateActiveVisit = async (patientUuid) => {
        const active = visits.find(v => v.active);
        if (active) return active.uuid;
        return bahmniService.createVisit(patientUuid, 'OPD', 'OPD-1');
    };
    bahmniService.checkVisitExists = async (uuid) => {
        const v = visits.find(v => v.uuid === uuid);
        return { exists: !!v, voided: v ? v.voided : true, active: v ? v.active : false };
    };
    bahmniService.getTestUuid = async () => 'test-uuid-1';
    bahmniService.getVisitStartDateAndEndDate = async (uuid) => {
        const v = visits.find(v => v.uuid === uuid);
        return { startDatetime: v?.startDatetime || new Date().toISOString(), stopDatetime: v?.stopDatetime || null };
    };
    let uploadCount = 0;
    bahmniService.uploadDocument = async () => ({ url: `http://bahmni.local/doc-${++uploadCount}.pdf` });
    bahmniService.linkDocumentToPatient = async (payload) => { lastLinked = payload; return { success: true }; };

    // Prepare mocks for req/res/next
    const makeRes = () => {
        const out = { statusCode: 0, body: null };
        return {
            status(code) { this.statusCode = code; out.statusCode = code; return this; },
            json(data) { this.body = data; out.body = data; return this; }
        };
    };

    // First upload (new document)
    const req1 = { body: { documentId: doc.id, mrnNumber: 'TEST-MRN-123' }, user: { id: user.id } };
    const res1 = makeRes();
    await uploadToBahmni(req1, res1, (e) => { throw e; });
    const firstVisitUuid = res1.body.data.visitUuid;

    // Second upload (replacement)
    const req2 = { body: { documentId: doc.id, mrnNumber: 'TEST-MRN-123' }, user: { id: user.id } };
    const res2 = makeRes();
    await uploadToBahmni(req2, res2, (e) => { throw e; });
    const secondVisitUuid = res2.body.data.visitUuid;

    // Assertions
    if (firstVisitUuid !== secondVisitUuid) throw new Error('Visit UUID should be reused for replacement');
    const activeVisitsCount = visits.filter(v => v.active).length;
    if (activeVisitsCount !== 1) throw new Error(`Expected 1 active visit, found ${activeVisitsCount}`);
    if (!lastLinked || lastLinked.visitUuid !== firstVisitUuid) throw new Error('Document not linked to correct encounter/visit');

    const updatedDoc = await db.document.findUnique({ where: { id: doc.id } });
    if (!updatedDoc.visitUUid || !updatedDoc.bahmniUrl || !updatedDoc.uploadedAt) {
        throw new Error('Database was not updated correctly with visitUuid, bahmniUrl, and uploadedAt');
    }

    // Restore originals
    Object.assign(bahmniService, original);
    db.user = originalDb.user;
    db.document = originalDb.document;

    return { ok: true, firstVisitUuid, secondVisitUuid, bahmniUrl: updatedDoc.bahmniUrl };
}

module.exports = {
	uploadToBahmni,
	getAllApprovedDocuments,
	getALlUploadedDocuments,
	testBahmniUploadLogic
};