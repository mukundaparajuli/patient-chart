const fs = require("fs").promises;
const path = require("path");
let db;
try {
    db = require("../config/db");
} catch (e) {
    db = { document: { findUnique: async () => { throw new Error("DB not available"); }, update: async () => { throw new Error("DB not available"); } } };
}
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
        if (!documentId) {
            throw new ApiError(400, "Document ID is required");
        }
        if (!mrnNumber) {
            throw new ApiError(400, "MRN number is required");
        }

        // Get document from database
        const document = await db.document.findUnique({
            where: { id: +documentId },
        });

        if (!document) {
            throw new ApiError(404, "Document not found");
        }

        if (document.status !== "approved" && document.status !== "uploaded" && document.status !== "rescanned_approved") {
            throw new ApiError(400, "Only approved or uploaded documents can be uploaded");
        }

        // Read file content
        const baseDir = path.resolve(__dirname, "..");
        const filePath = path.join(baseDir, document.filePath);
        let fileContent;

        try {
            await fs.access(filePath); // Check if file exists
            const stats = await fs.stat(filePath);

            // Check file size (limit to 10MB)
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

        // Decide visit reuse/create based on document state
        let visitUuid = null;
        if (document.status === 'uploaded' && document.visitUUid) {
            const exists = await bahmniService.checkVisitExists(document.visitUUid);
            if (exists) {
                visitUuid = document.visitUUid;
            }
        }
        if (!visitUuid) {
            const activeVisit = await bahmniService.getActiveVisit(patientUuid);
            if (activeVisit && activeVisit.uuid) {
                visitUuid = activeVisit.uuid;
            }
        }
        if (!visitUuid) {
            visitUuid = await bahmniService.getOrCreateActiveVisit(
                patientUuid,
                env.bahmni.visitType || "OPD",
                env.bahmni.locationName || "Bahmni Clinic"
            );
        }

        // Prepare other required UUIDs in parallel
        const [visitTypeUuid, encounterTypeUuid, providerUuid, locationUuid] = await Promise.all([
            bahmniService.getVisitTypeId(env.bahmni.visitType || "OPD"),
            bahmniService.getEncounterTypeId("Patient Document"),
            bahmniService.getProviderUuid(patientUuid, "Patient Document"),
            bahmniService.getLocationUuidByName(env.bahmni.locationName || "Bahmni Clinic"),
        ]);

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

        // Get visit dates (best-effort)
        let visitDates = { startDatetime: new Date().toISOString(), stopDatetime: null };
        try {
            const { startDatetime, stopDatetime } = await bahmniService.getVisitStartDateAndEndDate(visitUuid);
            if (startDatetime) visitDates.startDatetime = startDatetime;
            if (stopDatetime) visitDates.stopDatetime = stopDatetime;
        } catch (_) { }

        // Link document to patient encounter
        await bahmniService.linkDocumentToPatient({
            patientUuid,
            visitTypeUuid,
            visitStartDate: visitDates.startDatetime,
            encounterTypeUuid,
            encounterDateTime: null,
            providerUuid,
            visitUuid,
            locationUuid,
            documents: [
                {
                    testUuid: await bahmniService.getTestUuid(),
                    image: uploadResponse.url,
                    obsDateTime: null,
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

        // Convert non-ApiError instances to ApiError for consistency
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

module.exports = {
    uploadToBahmni,
    getAllApprovedDocuments,
    getALlUploadedDocuments
};

// Self-check function (dev utility)
async function testBahmniUploadLogic() {
    const original = {
        findUnique: db.document.findUnique,
        update: db.document.update,
        svc: { ...bahmniService },
    };

    // Create a tiny temp file
    const tmpDir = path.resolve(__dirname, "..", "tmp");
    const tmpFileRel = path.join("tmp", "test.pdf");
    const tmpFileAbs = path.join(path.resolve(__dirname, ".."), tmpFileRel);
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(tmpFileAbs, Buffer.from("dummy pdf content"));

    let storedDoc = {
        id: 1,
        scannerId: 1,
        employeeId: "E1",
        fileName: "test.pdf",
        filePath: tmpFileRel,
        patientMRN: "MRN123",
        status: "approved",
        comment: "",
        bahmniUrl: null,
        visitUUid: null,
        scannedAt: new Date(),
    };

    let updatedPayloads = [];

    // Mock DB
    db.document.findUnique = async ({ where }) => {
        if (where.id !== storedDoc.id) return null;
        return { ...storedDoc };
    };
    db.document.update = async ({ where, data }) => {
        if (where.id !== storedDoc.id) throw new Error("Unexpected doc id");
        storedDoc = { ...storedDoc, ...data };
        updatedPayloads.push({ ...data });
        return { ...storedDoc };
    };

    // In-memory Bahmni state
    let activeVisit = null;
    let createdVisitCount = 0;
    let linkedCount = 0;

    // Mock Bahmni service methods
    bahmniService.getPatientUuid = async () => "patient-uuid";
    bahmniService.getVisitTypeId = async () => "visit-type-uuid";
    bahmniService.getEncounterTypeId = async () => "encounter-type-uuid";
    bahmniService.getProviderUuid = async () => "provider-uuid";
    bahmniService.getLocationUuidByName = async () => "location-uuid";
    bahmniService.getActiveVisit = async () => activeVisit;
    bahmniService.createVisit = async () => {
        createdVisitCount += 1;
        activeVisit = { uuid: "visit-uuid-1", startDatetime: new Date().toISOString(), stopDatetime: null };
        return activeVisit.uuid;
    };
    bahmniService.getOrCreateActiveVisit = async (patientUuid, vt, loc) => {
        if (activeVisit) return activeVisit.uuid;
        return bahmniService.createVisit(patientUuid, vt, loc);
    };
    bahmniService.checkVisitExists = async (uuid) => !!activeVisit && activeVisit.uuid === uuid;
    bahmniService.getVisitStartDateAndEndDate = async (uuid) => ({ startDatetime: new Date().toISOString(), stopDatetime: null });
    bahmniService.getTestUuid = async () => "test-uuid";
    bahmniService.uploadDocument = async () => ({ url: "http://bahmni/doc1.png" });
    bahmniService.linkDocumentToPatient = async () => { linkedCount += 1; return { ok: true }; };

    // Fake req/res/next
    const makeRes = () => {
        const res = { statusCode: null, jsonBody: null };
        res.status = (code) => { res.statusCode = code; return res; };
        res.json = (body) => { res.jsonBody = body; return res; };
        return res;
    };

    // 1) New upload: should create one active visit and link
    {
        const req = { body: { documentId: 1, mrnNumber: "MRN123" }, user: { id: 99 } };
        const res = makeRes();
        const next = (err) => { if (err) throw err; };
        await uploadToBahmni(req, res, next);
        if (createdVisitCount !== 1) throw new Error("Expected one visit to be created");
        if (!storedDoc.visitUUid || storedDoc.visitUUid !== activeVisit.uuid) throw new Error("Document visitUuid not set correctly");
        if (!storedDoc.bahmniUrl) throw new Error("bahmniUrl not set");
        if (!storedDoc.uploadedAt) throw new Error("uploadedAt not set");
        if (linkedCount !== 1) throw new Error("Document not linked to encounter");
        if (res.statusCode !== 200) throw new Error("Unexpected response status for new upload");
    }

    // 2) Replacement: reuse stored visit, no new visit creation
    {
        storedDoc.status = "uploaded";
        storedDoc.bahmniUrl = "http://bahmni/old.png";
        storedDoc.visitUUid = activeVisit.uuid;
        bahmniService.uploadDocument = async () => ({ url: "http://bahmni/doc2.png" });
        const req = { body: { documentId: 1, mrnNumber: "MRN123" }, user: { id: 99 } };
        const res = makeRes();
        const next = (err) => { if (err) throw err; };
        await uploadToBahmni(req, res, next);
        if (createdVisitCount !== 1) throw new Error("No new visit should be created on replacement");
        if (storedDoc.visitUUid !== activeVisit.uuid) throw new Error("Replacement should keep same visitUuid");
        if (linkedCount !== 2) throw new Error("Replacement should link again");
    }

    // 3) Replacement with invalid stored visit: fallback to active visit
    {
        storedDoc.status = "uploaded";
        storedDoc.bahmniUrl = "http://bahmni/old2.png";
        storedDoc.visitUUid = "deleted-visit";
        bahmniService.checkVisitExists = async (uuid) => uuid !== "deleted-visit";
        const req = { body: { documentId: 1, mrnNumber: "MRN123" }, user: { id: 99 } };
        const res = makeRes();
        const next = (err) => { if (err) throw err; };
        await uploadToBahmni(req, res, next);
        if (createdVisitCount !== 1) throw new Error("Still should not create new visit if an active one exists");
        if (storedDoc.visitUUid !== activeVisit.uuid) throw new Error("Should fallback to active visitUuid");
        if (linkedCount !== 3) throw new Error("Should link again after replacement with invalid visit");
    }

    // Restore originals
    db.document.findUnique = original.findUnique;
    db.document.update = original.update;
    Object.assign(bahmniService, original.svc);

    return { ok: true };
}

module.exports.testBahmniUploadLogic = testBahmniUploadLogic;